import { neon } from "@neondatabase/serverless";
import config from "../config/config.js";

// HTTP driver for reads and single statements. Anything that must read and
// then write atomically goes through the pg pool in pool.ts instead. The
// schema lives in schema.ts and is applied by server.ts before listening.
const sql = neon(config.DATABASE_URL);

export default sql;
