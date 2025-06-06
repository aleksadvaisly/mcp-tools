#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const dotenvExpand = require('dotenv-expand');
dotenvExpand.expand(dotenv.config());

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import micromatch from "micromatch";

const server = new Server(
  {
    name: "example-servers/postgres-enhanced",
    version: "0.3.0", // Inkrementacja wersji ze względu na zmianę API narzędzi
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// --- Pobieranie URL bazy danych ---
const args = process.argv.slice(2);
let databaseUrl: string | undefined;
let urlSource: string = "unknown"; // Zmienna do przechowywania informacji o źródle URL

if (args[0]) {
  databaseUrl = args[0];
  urlSource = "command-line argument";
} else if (process.env.POSTGRES_URL) {
  databaseUrl = process.env.POSTGRES_URL;
  urlSource = "POSTGRES_URL environment variable (loaded from .env file or system)";
}

if (!databaseUrl) {
  console.error(
    "Database URL not provided. Please provide it as a command-line argument, " +
    "set the POSTGRES_URL environment variable, or define it in a .env file."
  );
  process.exit(1);
}

const finalDatabaseUrl = databaseUrl as string;

const resourceBaseUrl = new URL(finalDatabaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const pool = new pg.Pool({
  connectionString: finalDatabaseUrl,
});

const SCHEMA_PATH = "schema";

// Funkcja do bezpiecznego dzielenia zapytań SQL na średnikach, ignorując średniki wewnątrz stringów i identyfikatorów
const splitSqlStatements = (fullSql: string): string[] => {
  const statements: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBlockComment = false;
  let inLineComment = false;
  let currentStatement = '';

  for (let i = 0; i < fullSql.length; i++) {
    const char = fullSql[i];
    const nextChar = fullSql[i + 1];

    // Obsługa komentarzy blokowych /* ... */
    if (char === '/' && nextChar === '*' && !inSingleQuote && !inDoubleQuote && !inLineComment) {
      inBlockComment = true;
      currentStatement += char;
      i++; // Przesuń wskaźnik o jeden, aby pominąć '*'
      currentStatement += nextChar;
      continue;
    }
    if (char === '*' && nextChar === '/' && inBlockComment) {
      inBlockComment = false;
      currentStatement += char;
      i++; // Przesuń wskaźnik o jeden, aby pominąć '/'
      currentStatement += nextChar;
      continue;
    }

    // Obsługa komentarzy liniowych --
    if (char === '-' && nextChar === '-' && !inSingleQuote && !inDoubleQuote && !inBlockComment) {
      inLineComment = true;
      currentStatement += char;
      i++; // Przesuń wskaźnik o jeden, aby pominąć '-'
      currentStatement += nextChar;
      continue;
    }
    if (char === '\n' && inLineComment) {
      inLineComment = false;
      currentStatement += char;
      continue;
    }

    if (inBlockComment || inLineComment) {
      currentStatement += char;
      continue;
    }

    // Obsługa cudzysłowów pojedynczych
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentStatement += char;
      continue;
    }

    // Obsługa cudzysłowów podwójnych (dla identyfikatorów)
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentStatement += char;
      continue;
    }

    // Dzielenie na średnikach poza cudzysłowami
    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const trimmedStatement = currentStatement.trim();
      if (trimmedStatement.length > 0) {
        statements.push(trimmedStatement);
      }
      currentStatement = '';
    } else {
      currentStatement += char;
    }
  }

  // Dodaj ostatnie zapytanie, jeśli istnieje
  const trimmedLastStatement = currentStatement.trim();
  if (trimmedLastStatement.length > 0) {
    statements.push(trimmedLastStatement);
  }
  return statements;
};

// --- Obsługa zasobów (istniejąca logika) ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return {
      resources: result.rows.map((row) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } finally {
    client.release();
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH || !tableName) {
    throw new Error("Invalid resource URI");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'",
      [tableName],
    );

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
    };
  } finally {
    client.release();
  }
});

// --- Definicje narzędzi ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sql_select_engine",
        description: `Allows you to perform parameterized SQL SELECT queries on the table.
Use placeholders like $1, $2 in your 'query_template' and provide corresponding values in the 'query_values' array.
This ensures proper handling of special characters in values and prevents SQL injection.
Note that in case of columns of type VECTOR, you can query them with embedding similarity functions.
Example arguments for querying with an embedding similarity function:
{
  "query_template": "SELECT profile FROM clients ORDER BY profile_embedding <=> embedding_bge($1) LIMIT $2;",
  "query_values": ["Tall person with glasses", 100]
}`,
        inputSchema: {
          type: "object",
          properties: {
            query_template: {
              type: "string",
              description: "The SELECT query template with placeholders (e.g., $1, $2). This should be correct SQL against a table which exists in the database."
            },
            query_values: {
              type: "array",
              items: {}, // Pozwala na dowolne typy w tablicy
              default: [],
              description: "An array of values corresponding to the placeholders in the query_template. Order matters. Example: [$1_value, $2_value, ...]"
            },
            format: {
              type: "string",
              enum: ["json", "text", "markdown"],
              default: "json",
              description: "The format of the result. Possible values are \"text\", \"markdown\" and \"json\" (default)."
            },
          },
          required: ["query_template"],
        },
      },
      {
        name: "sql_update_engine",
        description: `Allows you to perform parameterized SQL UPDATE or INSERT queries on the table.
Use placeholders like $1, $2 in your 'query_template' and provide corresponding values in the 'query_values' array.
This ensures proper handling of special characters in values and prevents SQL injection.
INSERT queries can use the WITH clause in the 'query_template'.
DELETE or DDL (ALTER, CREATE, DROP) queries are NOT allowed with this tool.
Example arguments for an INSERT statement:
{
  "query_template": "INSERT INTO articles (sender, text_column) VALUES ($1, $2);",
  "query_values": ["user123", "Some text with 'quotes' and other special characters."]
}`,
        inputSchema: {
          type: "object",
          properties: {
            query_template: {
              type: "string",
              description: "The UPDATE or INSERT query template with placeholders (e.g., $1, $2). This should be correct SQL against a table which exists in the database."
            },
            query_values: {
              type: "array",
              items: {}, // Pozwala na dowolne typy w tablicy
              default: [],
              description: "An array of values corresponding to the placeholders in the query_template. Order matters."
            },
          },
          required: ["query_template"],
        },
      },
      {
        name: "sql_dml_engine",
        description: `Allows you to perform schema modification queries: ALTER TABLE, CREATE TABLE, CREATE INDEX, COMMENT ON. Use with caution. Full DROP or DELETE statements are generally NOT allowed with this tool. This tool accepts a full SQL query string, which can contain multiple statements separated by semicolons.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The DDL query (ALTER, CREATE TABLE/INDEX, COMMENT ON) to perform for schema modification. Can contain multiple statements separated by semicolons." },
          },
          required: ["query"],
        },
      },
      {
        name: "sql_schema_info_engine",
        description: `Retrieves comprehensive schema information including tables (name, comment), columns (name, type, comment), indexes, triggers, and foreign keys (including ON DELETE CASCADE rules) from the database. Tables are filtered according to the glob expression (e.g. “*” – everything, “?” – a single character, or a specific table name).`,
        inputSchema: {
          type: "object",
          properties: {
            glob_pattern: {
              type: "string",
              default: "*",
              description: "The glob expression used to filter table names."
            },
          },
        },
      },
    ],
  };
});

// --- Obsługa wywołań narzędzi ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "sql_select_engine") {
    const query_template = args?.query_template as string;
    const query_values = (args?.query_values as any[]) || [];
    const format = (args?.format as string || "json").toLowerCase();

    if (!query_template) {
      throw new Error("Missing 'query_template' argument for sql_select_engine");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(query_template, query_values);
      await client.query("ROLLBACK");

      let outputText: string;

      if (format === "json") {
        // Zwracamy tablicę obiektów, co jest bardziej standardowe dla JSON
        outputText = JSON.stringify(result.rows, null, 2);
      } else if (format === "text") {
        outputText = result.rows.map(row =>
          result.fields.map(field => String(row[field.name])).join('\n')
        ).join('\n\n');
      } else if (format === "markdown") {
        if (result.rows.length === 0) {
          outputText = "No results found.";
        } else {
          const headers = result.fields.map(f => f.name);
          const headerLine = `| ${headers.join(" | ")} |`;
          const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
          const dataLines = result.rows.map(row =>
            `| ${headers.map(header => String(row[header] ?? "")).join(" | ")} |`
          ).join("\n");
          outputText = `${headerLine}\n${separatorLine}\n${dataLines}`;
        }
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      return {
        content: [{ type: "text", text: outputText }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing sql_select_engine: ${error.message}`);
    } finally {
      client.release();
    }
  } else if (name === "sql_update_engine") {
    const query_template = args?.query_template as string;
    const query_values = (args?.query_values as any[]) || [];

    if (!query_template) {
      throw new Error("Missing 'query_template' argument for sql_update_engine");
    }

    const sqlTemplateNormalized = query_template.trim().toLowerCase();

    const isUpdate = sqlTemplateNormalized.includes("update ");
    const isInsert = sqlTemplateNormalized.includes("insert into ");
    const startsWithWith = sqlTemplateNormalized.startsWith("with ");

    if (!startsWithWith && !isUpdate && !isInsert) {
         return {
            content: [{ type: "text", text: "Only UPDATE or INSERT query templates (optionally starting with WITH) are allowed with sql_update_engine." }],
            isError: true,
         };
    }
    if (startsWithWith && !(isUpdate || isInsert)) {
        return {
            content: [{ type: "text", text: "WITH clause must be followed by an UPDATE or INSERT statement in the query_template for sql_update_engine." }],
            isError: true,
         };
    }

    const disallowedKeywords = ["delete", "alter", "create", "drop"];
    if (disallowedKeywords.some(keyword => sqlTemplateNormalized.startsWith(`${keyword} `))) {
      return {
        content: [{ type: "text", text: `Disallowed keyword found in sql_update_engine query_template. Blocked keywords: ${disallowedKeywords.join(", ")}` }],
        isError: true,
      };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(query_template, query_values);
      await client.query("COMMIT");
      return {
        content: [{ type: "text", text: `Query executed successfully. Rows affected: ${String(result.rowCount ?? 0)}` }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
         console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing sql_update_engine: ${error.message}`);
    } finally {
      client.release();
    }
  } else if (name === "sql_dml_engine") {
    const sql = args?.query as string;

    if (!sql) {
      throw new Error("Missing 'query' argument for sql_dml_engine");
    }

    const statements = splitSqlStatements(sql);
    const results: string[] = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN"); // Rozpocznij transakcję dla wielu zapytań

      for (const statement of statements) {
        const queryUpper = statement.toUpperCase().trim();

        const isAlter = queryUpper.startsWith("ALTER ");
        const isCreateTable = queryUpper.startsWith("CREATE TABLE ");
        const isCreateIndex = queryUpper.startsWith("CREATE INDEX ") || queryUpper.startsWith("CREATE UNIQUE INDEX ");
        const isCommentOn = queryUpper.startsWith("COMMENT ON ");

        if (!(isAlter || isCreateTable || isCreateIndex || isCommentOn)) {
          await client.query("ROLLBACK"); // Wycofaj transakcję w przypadku niedozwolonego zapytania
          return {
            content: [{ type: "text", text: `Only ALTER, CREATE TABLE, CREATE INDEX, or COMMENT ON queries are allowed with sql_dml_engine. Disallowed query: ${statement}` }],
            isError: true,
          };
        }

        if (isAlter) {
            if (queryUpper.includes("DROP") &&
                !queryUpper.match(/ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN/i) &&
                !queryUpper.match(/ALTER\s+TABLE\s+\S+\s+DROP\s+CONSTRAINT/i) &&
                !queryUpper.match(/ALTER\s+TYPE\s+\S+\s+DROP\s+ATTRIBUTE/i)
            ) {
               await client.query("ROLLBACK"); // Wycofaj transakcję
               return {
                 content: [{ type: "text", text: `Disallowed DROP keyword found within ALTER statement. Only specific subcommands like DROP COLUMN/CONSTRAINT are permitted. Query: ${statement}` }],
                 isError: true,
               };
            }
        }

        await client.query(statement);
        results.push(`Query executed successfully: ${statement.substring(0, 50)}...`);
      }

      await client.query("COMMIT"); // Zatwierdź transakcję po wszystkich zapytaniach
      return {
        content: [{ type: "text", text: `Schema modification queries executed successfully.\n${results.join('\n')}` }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
         console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing sql_dml_engine: ${error.message}`);
    } finally {
      client.release();
    }
  }
  else if (name === "sql_schema_info_engine") {
    const globPattern = args?.glob_pattern as string || "*";
    const client = await pool.connect();

    try {
      const allTablesResult = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      const allTableNames = allTablesResult.rows.map(row => row.table_name);

      const matchedTableNames = micromatch(allTableNames, globPattern);

      const tablesInfo = [];

      for (const tableName of matchedTableNames) {
        const tableCommentResult = await client.query(
          `SELECT pg_catalog.obj_description(c.oid, 'pg_class') AS comment
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = $1 AND n.nspname = 'public'`,
          [tableName]
        );
        const tableComment = tableCommentResult.rows[0]?.comment ?? "";

        const columnsResult = await client.query(
          `SELECT
               cols.column_name,
               cols.data_type,
               cols.character_maximum_length,
               cols.numeric_precision,
               cols.numeric_scale,
               cols.is_nullable,
               cols.column_default,
               cols.udt_name, -- Dodano udt_name
               pg_catalog.col_description(cls.oid, cols.ordinal_position) AS column_comment
           FROM information_schema.columns AS cols
           JOIN pg_catalog.pg_class AS cls ON cls.relname = cols.table_name AND cls.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public')
           WHERE cols.table_schema = 'public'
             AND cols.table_name = $1
           ORDER BY cols.ordinal_position`,
          [tableName]
        );

        const colsInfo = columnsResult.rows.map(col => {
          const columnInfo: { [key: string]: any } = {
            column_name: col.column_name,
            column_type: col.data_type,
            column_comment: col.column_comment ?? "",
            is_nullable: col.is_nullable === 'YES', // Konwersja na boolean
            udt_name: col.udt_name,
          };

          if (col.character_maximum_length !== null) {
            columnInfo.character_maximum_length = col.character_maximum_length;
          }
          if (col.numeric_precision !== null) {
            columnInfo.numeric_precision = col.numeric_precision;
          }
          if (col.numeric_scale !== null) {
            columnInfo.numeric_scale = col.numeric_scale;
          }
          if (col.column_default !== null) {
            columnInfo.column_default = col.column_default;
          }
          // Dodaj vector_dimensions tylko jeśli nie jest null
          if (col.vector_dimensions !== null) {
            columnInfo.vector_dimensions = col.vector_dimensions;
          }

          return columnInfo;
        });

        // Logika do pobierania rozmiaru vectora
        for (const col of colsInfo) {
          if (col.column_type === 'USER-DEFINED' && col.udt_name === 'vector') {
            const vectorDimensionsResult = await client.query(
              `SELECT atttypmod
               FROM pg_attribute
               WHERE attrelid = (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))
               AND attname = $2`,
              [tableName, col.column_name]
            );
            if (vectorDimensionsResult.rows.length > 0) {
              // atttypmod dla vectora przechowuje wymiary + 4 (dla typu vector)
              // np. vector(1536) -> atttypmod = 1536 + 4 = 1540
              const atttypmod = vectorDimensionsResult.rows[0].atttypmod;
              // Użytkownik wymaga, aby zwracać surową wartość atttypmod jako rozmiar vectora
              col.vector_dimensions = atttypmod;
            }
          }
        }

        tablesInfo.push({
          table_name: tableName,
          table_comment: tableComment,
          columns: colsInfo,
          indexes: [] as any[],
          triggers: [] as any[],
          foreign_keys: [] as any[],
          primary_keys: [] as any[], // Dodano placeholder dla kluczy głównych
        });

        // Pobieranie informacji o indeksach
        const indexesResult = await client.query(
          `SELECT
               indexname AS index_name,
               indexdef AS index_definition
           FROM pg_indexes
           WHERE tablename = $1 AND schemaname = 'public'`,
          [tableName]
        );
        const currentTableIndexes = indexesResult.rows.map(idx => ({
          index_name: idx.index_name,
          index_definition: idx.index_definition
        }));
        tablesInfo[tablesInfo.length - 1].indexes = currentTableIndexes;
        console.log(`Indexes for ${tableName}:`, currentTableIndexes);


        // Pobieranie informacji o triggerach
        const triggersResult = await client.query(
          `SELECT
               tgname AS trigger_name,
               pg_get_triggerdef(t.oid) AS trigger_definition
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = $1 AND n.nspname = 'public'`,
          [tableName]
        );
        const currentTableTriggers = triggersResult.rows.map(trg => ({
          trigger_name: trg.trigger_name,
          trigger_definition: trg.trigger_definition
        }));
        tablesInfo[tablesInfo.length - 1].triggers = currentTableTriggers;
        console.log(`Triggers for ${tableName}:`, currentTableTriggers);


        // Pobieranie informacji o kluczach obcych
        const foreignKeysResult = await client.query(
          `SELECT
               tc.constraint_name,
               kcu.column_name,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name,
               rc.delete_rule AS on_delete_rule
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage AS ccu
             ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
           JOIN information_schema.referential_constraints AS rc
             ON rc.constraint_name = tc.constraint_name
             AND rc.constraint_schema = tc.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_name = $1
             AND tc.table_schema = 'public'`,
          [tableName]
        );
        const currentTableForeignKeys = foreignKeysResult.rows.map(fk => ({
          constraint_name: fk.constraint_name,
          column_name: fk.column_name,
          foreign_table_name: fk.foreign_table_name,
          foreign_column_name: fk.foreign_column_name,
          on_delete_rule: fk.on_delete_rule
        }));
        tablesInfo[tablesInfo.length - 1].foreign_keys = currentTableForeignKeys;
        console.log(`Foreign Keys for ${tableName}:`, currentTableForeignKeys);

        // Pobieranie informacji o kluczach głównych
        const primaryKeysResult = await client.query(
          `SELECT
               kcu.column_name
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_name = $1
             AND tc.table_schema = 'public'
           ORDER BY kcu.ordinal_position`,
          [tableName]
        );
        const currentTablePrimaryKeys = primaryKeysResult.rows.map(pk => pk.column_name);
        tablesInfo[tablesInfo.length - 1].primary_keys = currentTablePrimaryKeys;
        console.log(`Primary Keys for ${tableName}:`, currentTablePrimaryKeys);

      }
      console.log("Final tablesInfo before JSON.stringify:", tablesInfo);

      return {
        content: [{ type: "text", text: JSON.stringify({ tables: tablesInfo.length > 0 ? tablesInfo : {} }, null, 2) }],
        isError: false,
      };
    } catch (error: any) {
        throw new Error(`Error executing sql_schema_info_engine: ${error.message}`);
    }
    finally {
      client.release();
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.info(`MCP server for PostgreSQL (enhanced) is running using database URL from ${urlSource} and connected via stdio.`);
}

runServer().catch(error => {
    console.error("Failed to run server:", error);
    process.exit(1);
});
