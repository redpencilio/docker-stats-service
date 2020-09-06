// see https://github.com/mu-semtech/mu-javascript-template for more info
import { app, query, errorHandler } from 'mu';

class MonitoredContainer {
  /**
   * URI which identifies the container.
   */
  uri = null;

  /**
   * Docker ID of the container.
   */
  dockerId = null;

  /**
   * The name of the container for enriching the log.
   */
  name = null;

  /**
   * The name of the project for enriching the log.
   */
  project = null;

  /**
   * Date indicating when this container was last queried for changes.
   */
  lastScanAt = null;

  /**
   * JSON object containing information about the last scan.
   *
   * This entity is used to calculate differences between different scans.
   */
  lastScanContent = null;
}

/**
 * Contains the list of all containers which should be monitored.
 */
let monitoredContainers = [];

updateMonitoredContainers();

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
  res.status(204);
});

// DONE: Query for containers to watch on boot

// DONE: Inspect incoming delta changes to refetch list of servers to monitor

// TODO: Build inspection loop to fetch container information

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
             SELECT ?uri ?dockerId ?name ?project WHERE {
               ?uri a docker:Container;
                    docker:id ?dockerId;
                    docker:name ?name;
                    docker:state/docker:status "running";
                    docker:label/docker:key "logging"
               OPTIONAL {
                 ?uri docker:label ?label.
                 ?label docker:key "com.docker.compose.project";
                        docker:value ?project.
               }
             }`))
          .results
          .bindings;

    // filter out elements in the current array which don't exist anymore
    let monitoredContainersCopy = [...monitoredContainers];
    monitoredContainersCopy =
      monitoredContainersCopy
      .filter( (container) =>
        dbContainers.find( (binding) =>
          binding.uri.value == container.uri ));

    // add new elements to the array
    let newContainers =
        dbContainers
        .filter( (bindings) =>
          ! monitoredContainersCopy.find( (container) =>
            container.uri == bindings.uri.value ) )
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

app.get('/', function( req, res ) {
  res.send('Hello mu-javascript-template');
} );

app.use(errorHandler);
