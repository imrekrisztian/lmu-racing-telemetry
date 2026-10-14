'use strict';

const { DuckDBInstance } = require('@duckdb/node-api');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = '2';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** Open (creating if needed) a lmu-racing-telemetry database and apply the schema. */
async function open(file) {
    const instance = await DuckDBInstance.create(file);
    const con = await instance.connect();
    await con.run(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    return { instance, con };
}

async function scalar(con, sql) {
    const rows = await (await con.run(sql)).getRowObjects();
    return rows.length ? Object.values(rows[0])[0] : null;
}

/**
 * Attach someone else's reference database read-only so its laps can be
 * compared against yours. Refuses on schema mismatch rather than silently
 * producing wrong joins -- the whole point of meta.schema_version.
 */
async function attachReference(con, file, alias = 'ref') {
    if (!fs.existsSync(file)) throw new Error(`Reference database not found: ${file}`);

    await con.run(`ATTACH '${file.replace(/'/g, "''")}' AS ${alias} (READ_ONLY)`);

    let version;
    try {
        version = await scalar(con, `SELECT value FROM ${alias}.meta WHERE key = 'schema_version'`);
    } catch {
        await con.run(`DETACH ${alias}`);
        throw new Error(`${path.basename(file)} has no meta table -- not an lmu-racing-telemetry database.`);
    }

    if (version !== SCHEMA_VERSION) {
        await con.run(`DETACH ${alias}`);
        throw new Error(
            `Schema mismatch: ${path.basename(file)} is v${version}, this build expects v${SCHEMA_VERSION}. ` +
            `Re-export it as Parquet, or migrate the file.`
        );
    }
    return alias;
}

module.exports = { open, attachReference, scalar, SCHEMA_VERSION };
