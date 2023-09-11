// see https://github.com/mu-semtech/mu-javascript-template for more info
import { app, query, errorHandler } from 'mu';
import http from 'http';
import request from 'request';

const CONTAINER_STATS_QUERY_INTERVAL = process.env.QUERY_INTERVAL || 10000

class MonitoredContainer {
  /**
   * URI which identifies the container.
   */
  uri;

  /**
   * Docker ID of the container.
   */
  dockerId;

  /**
   * The name of the container for enriching the log.
   */
  name;

  /**
   * The name of the project for enriching the log.
   */
  project;

  /**
   * Date indicating when this container was last queried for changes.
   */
  lastScanAt;

  /**
   * JSON object containing information about the last scan.
   *
   * This entity is used to calculate differences between different scans.
   */
  lastScanContent;

  constructor( options ) {
    for( const key in options ) {
      this[key] = options[key];
    }
  }
}

/**
 * Contains the list of all containers which should be monitored.
 */
let monitoredContainers = [];
updateMonitoredContainers();
setInterval(fetchContainerStats, CONTAINER_STATS_QUERY_INTERVAL);

/**
 * Delta messages endpoint.
 *
 * Upon receiving a delta, we fetch the new statusus of the
 * containers.  This should be sufficient for the vast majority of
 * cases.  Only situation to cater for still, is a crashing service
 * that auto-restarts.
 */
app.post("/.mu/delta", async (_req, res) => {
  await updateMonitoredContainers();
  res.sendStatus(204);
});

// DONE: Query for containers to watch on boot

// DONE: Inspect incoming delta changes to refetch list of servers to monitor

// DONE: Build inspection loop to fetch container information

/**
 * Updates the monitored containers.
 *
 * Assumes the global variable `monitoredContainers` can be set.
 */
async function updateMonitoredContainers() {
  // first query the database to see if it is up.
  try {
    await query(`SELECT * WHERE { ?s ?P ?o. } LIMIT 1`);

    // get a list of all running containers
    const dbContainers =
          (await query(
            `PREFIX docker: <https://w3.org/ns/bde/docker#>
             SELECT DISTINCT ?uri ?dockerId ?name WHERE {
               ?uri a docker:Container;
                    docker:id ?dockerId;
                    docker:name ?name;
                    docker:state/docker:status "running";
                    docker:label/docker:key "logging".
             }`))
          .results
          .bindings;

    for (const dbContainer of dbContainers) {
      const result = await query(
        `PREFIX docker: <https://w3.org/ns/bde/docker#>
         SELECT ?project WHERE {
           <${dbContainer.uri.value}> docker:label ?label .
           ?label docker:key "com.docker.compose.project";
                  docker:value ?project.
         } LIMIT 1`);
      if (result.results.bindings.length) {
        dbContainer.project = result.results.bindings[0].project;
      }
    }

    // filter out elements in the current array which don't exist anymore
    let monitoredContainersCopy = [...monitoredContainers];
    monitoredContainersCopy =
      monitoredContainersCopy
      .filter( (container) => {
        const foundContainer = dbContainers.find( (binding) => binding.uri.value == container.uri );
        if( foundContainer )
          return true;
        else {
          return false;
        }
      });

    // add new elements to the array
    let newContainers =
        dbContainers
        .filter( (bindings) =>
          {
            const foundContainer = monitoredContainersCopy.find( (container) =>
              container.uri == bindings.uri.value );
            if( foundContainer )
              return false;
            else {
              return true;
            }
        } )
        .map( (bindings) =>
          new MonitoredContainer( {
            uri: bindings.uri.value,
            dockerId: bindings.dockerId.value,
            name: bindings.name.value,
            project: bindings.project.value
          } ) );

    monitoredContainers = [...monitoredContainersCopy, ...newContainers];
  } catch (e) {
    // could not fetch containers, retrying in a moment

    console.log("SPARQL endpoint does not seem to be up yet, retrying in 2500ms");
    setTimeout( updateMonitoredContainers, 2500 );
  }
}

async function fetchContainerStats() {
  // console.log(`Fetching stats for ${monitoredContainers.length} containers.`);

  monitoredContainers.forEach( async (container) => {
    // Get new stats from backend
    const req = http.request({
      socketPath: "/var/run/docker.sock",
      path: `http:/v1.24/containers/${container.dockerId}/stats?stream=false`
    }, (req) => {
      let data = "";
      req
        .on('data', (d) => data += d )
        .on('end', async () => {
          // Parse the data from the stats instance
          const newData = cleanupData(JSON.parse( data ), container);
          const oldData = container.lastScanContent;

          if( newData.message ) {
            // could not find the container, most likely.
            return;
          }

          // Enrich with relative numbers
          if( oldData ) {
            // TODO: add diffs to the newData
          }

          // Update stats in monitored container
          container.lastScanContent = newData;

          // Store stats through logstash
          try {
            request({
              url: "http://logstash:8080/",
              method: "POST",
              json: true,
              body: newData
            }, (error, _response, _body) => {
              if( error ) {
                console.error(`Error whilst sending content to logstash: ${error}`);
              } else {
                // console.log(`Sent stats for ${container.project} / ${container.name} / ${container.dockerId}`);
              }
            });
          } catch (e) {
            console.error(`Error whilst sending content to logstash: ${e}`);
          }
        });
      });
    req.end();
  });
}

/**
 * Cleans up data received from the stats event.
 */
function cleanupData( data, container ) {
  const storedInfo = {};
  storedInfo.created = data.read;
  storedInfo.fields = {
    compose_project: container.project,
    compose_service: container.name
  };

  if( data.Labels ) {
    storedInfo.project = data.Labels["com.docker.compose.project"];
    storedInfo.service = data.Labels["com.docker.compose.service"];
  }
  storedInfo.network = data.network || {};
  storedInfo.io = data.blkio_stats;
  storedInfo.cpu = data.cpu_stats;
  storedInfo.procs = data.num_procs;
  storedInfo.mem = data.memory_stats;
  storedInfo.net = data.networks;

  return storedInfo;
}

app.use(errorHandler);
