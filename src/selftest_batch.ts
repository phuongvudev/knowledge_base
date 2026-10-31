// Child process for selftest: batch-ingests a dir like the MCP server would (separate process, same DB)
import { initDatabase } from "./database.js";
import { handleIngestionTool } from "./tools/ingestion_tools.js";

const [project_id, dir_path] = process.argv.slice(2);
await handleIngestionTool("kb_batch_ingest_directory", { project_id, dir_path }, initDatabase());
process.exit(0);
