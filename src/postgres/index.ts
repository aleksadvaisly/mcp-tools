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
    version: "0.4.0", // Refaktor: uproszczone nazwy i logika walidacji
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// --- Pobieranie URL bazy danych i konfiguracji ---
const args = process.argv.slice(2);
let databaseUrl: string | undefined;
let urlSource: string = "unknown";

// Kontrola dostępności narzędzia access przez zmienną środowiskową
const accessFeatureEnabled = process.env.MCP_POSTGRES_ACCESS_FEATURE?.toLowerCase() === 'true';

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

// Funkcja do bezpiecznego dzielenia zapytań SQL na średnikach, ignorując średniki wewnątrz stringów, identyfikatorów i dollar-quoted strings
const splitSqlStatements = (fullSql: string): string[] => {
  const statements: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBlockComment = false;
  let inLineComment = false;
  let inDollarQuote = false;
  let dollarQuoteTag = '';
  let currentStatement = '';

  for (let i = 0; i < fullSql.length; i++) {
    const char = fullSql[i];
    const nextChar = fullSql[i + 1];

    // Obsługa komentarzy blokowych /* ... */
    if (char === '/' && nextChar === '*' && !inSingleQuote && !inDoubleQuote && !inDollarQuote && !inLineComment) {
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
    if (char === '-' && nextChar === '-' && !inSingleQuote && !inDoubleQuote && !inDollarQuote && !inBlockComment) {
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

    // Obsługa dollar-quoted strings $tag$...$tag$
    if (char === '$' && !inSingleQuote && !inDoubleQuote) {
      if (!inDollarQuote) {
        // Rozpoczęcie dollar-quoted string - znajdź tag
        let tagEnd = i + 1;
        while (tagEnd < fullSql.length && fullSql[tagEnd] !== '$') {
          tagEnd++;
        }
        if (tagEnd < fullSql.length) {
          const tag = fullSql.substring(i + 1, tagEnd);
          dollarQuoteTag = tag;
          inDollarQuote = true;
          // Dodaj całą sekwencję $tag$ do current statement
          const dollarStart = fullSql.substring(i, tagEnd + 1);
          currentStatement += dollarStart;
          i = tagEnd; // Przesuń wskaźnik na koniec $tag$
          continue;
        }
      } else {
        // Sprawdź czy to koniec dollar-quoted string
        let tagEnd = i + 1;
        while (tagEnd < fullSql.length && fullSql[tagEnd] !== '$') {
          tagEnd++;
        }
        if (tagEnd < fullSql.length) {
          const tag = fullSql.substring(i + 1, tagEnd);
          if (tag === dollarQuoteTag) {
            inDollarQuote = false;
            dollarQuoteTag = '';
            // Dodaj całą sekwencję $tag$ do current statement
            const dollarEnd = fullSql.substring(i, tagEnd + 1);
            currentStatement += dollarEnd;
            i = tagEnd; // Przesuń wskaźnik na koniec $tag$
            continue;
          }
        }
      }
    }

    if (inDollarQuote) {
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

    // Dzielenie na średnikach poza cudzysłowami i dollar-quoted strings
    if (char === ';' && !inSingleQuote && !inDoubleQuote && !inDollarQuote) {
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

// Funkcja walidacji answer (bez ujawniania poprawnych wartości)
const validateAnswer = (answer: string): boolean => {
  const allowedAnswers = ["true", "tak", "1", "ok", "proceed", "go", "yes", "apply"];
  return allowedAnswers.includes(answer.toLowerCase());
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
  const baseTools = [
    {
      name: "select",
      description: `Perform parameterized SQL SELECT queries. Use placeholders like $1, $2 in your query and provide values array. Supports vector similarity functions for embedding columns.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The SELECT query with placeholders (e.g., $1, $2)."
          },
          values: {
            type: "array",
            items: {},
            default: [],
            description: "Array of values for placeholders. Order matters."
          },
          format: {
            type: "string",
            enum: ["json", "text", "markdown"],
            default: "json",
            description: "Output format: json (default), text, or markdown."
          },
        },
        required: ["query"],
      },
    },
    {
      name: "update",
      description: `Perform parameterized INSERT, UPDATE queries, and DO blocks. Use placeholders and values array for safe parameter binding. Supports anonymous PL/pgSQL blocks with DO statement.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "INSERT, UPDATE query, or DO block with placeholders."
          },
          values: {
            type: "array",
            items: {},
            default: [],
            description: "Array of values for placeholders."
          },
        },
        required: ["query"],
      },
    },
    {
      name: "create",
      description: `Perform schema creation and modification: CREATE (tables, indexes, views, functions, triggers), ALTER, COMMENT ON. Supports multiple statements separated by semicolons.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "DDL query for creating/altering schema objects. Multiple statements allowed with semicolons." },
        },
        required: ["query"],
      },
    },
    {
      name: "schema",
      description: `Get comprehensive database schema information: tables, columns, indexes, triggers, foreign keys, primary keys. Filter tables using glob patterns.`,
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            default: "*",
            description: "Glob pattern to filter table names (* for all)."
          },
        },
      },
    },
    {
      name: "functions",
      description: `Get database functions information including arguments, return types, language, owner and comments. Filter functions using glob patterns and control system functions visibility.`,
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            default: "*",
            description: "Glob pattern to filter function names (* for all)."
          },
          format: {
            type: "string",
            enum: ["json", "text", "markdown"],
            default: "json",
            description: "Output format: json (default), text, or markdown."
          },
          user: {
            type: "string",
            default: "postgres",
            description: "Glob pattern to filter function owners (* for all, default: postgres - excludes system users like supabase_admin)."
          },
        },
      },
    },
    {
      name: "rls_policies",
      description: `Get Row Level Security (RLS) policies information from the database. Returns policy details including commands, conditions, and target tables. Filter tables using glob patterns.`,
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            default: "*",
            description: "Glob pattern to filter table names (* for all)."
          },
          format: {
            type: "string",
            enum: ["json", "text", "markdown"],
            default: "json",
            description: "Output format: json (default), text, or markdown."
          },
        },
      },
    },
    {
      name: "delete",
      description: `Perform destructive operations: DELETE (with WHERE), DROP, TRUNCATE. Requires confirmation. Supports multiple statements.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Destructive SQL query. Multiple statements allowed with semicolons." },
          answer: { type: "string", description: "A magic answer from the user to proceed with the destructive operation. Ask them for this value first." }
        },
        required: ["query", "answer"],
      },
    },
  ];

  // Warunkowo dodaj narzędzie access tylko gdy włączone przez zmienną środowiskową
  if (accessFeatureEnabled) {
    baseTools.push({
      name: "access",
      description: `Manage database permissions: GRANT and REVOKE statements. Requires confirmation for security. Supports multiple statements.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GRANT or REVOKE statements. Multiple statements allowed with semicolons." },
          answer: { type: "string", description: "A magic answer from the user to proceed with the destructive operation. Ask them for this value first." }
        },
        required: ["query", "answer"],
      },
    });
  }

  return {
    tools: baseTools,
  };
});

// --- Obsługa wywołań narzędzi ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "select") {
    const query = args?.query as string;
    const values = (args?.values as any[]) || [];
    const format = (args?.format as string || "json").toLowerCase();

    if (!query) {
      throw new Error("Missing 'query' argument for select");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(query, values);
      await client.query("ROLLBACK");

      let outputText: string;

      if (format === "json") {
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
      throw new Error(`Error executing select: ${error.message}`);
    } finally {
      client.release();
    }
  } 
  
  else if (name === "update") {
    const query = args?.query as string;
    const values = (args?.values as any[]) || [];

    if (!query) {
      throw new Error("Missing 'query' argument for update");
    }

    const queryNormalized = query.trim().toLowerCase();
    const isUpdate = queryNormalized.includes("update ");
    const isInsert = queryNormalized.includes("insert into ");
    const startsWithWith = queryNormalized.startsWith("with ");
    const startsWithDo = queryNormalized.startsWith("do ");

    if (!startsWithWith && !startsWithDo && !isUpdate && !isInsert) {
      return {
        content: [{ type: "text", text: "Only UPDATE, INSERT, DO blocks, or queries starting with WITH are allowed with update tool." }],
        isError: true,
      };
    }
    if (startsWithWith && !(isUpdate || isInsert)) {
      return {
        content: [{ type: "text", text: "WITH clause must be followed by an UPDATE or INSERT statement." }],
        isError: true,
      };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(query, values);
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
      throw new Error(`Error executing update: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "create") {
    const query = args?.query as string;

    if (!query) {
      throw new Error("Missing 'query' argument for create");
    }

    const statements = splitSqlStatements(query);
    const results: string[] = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const statement of statements) {
        // Usuń komentarze z początku statement, żeby sprawdzić rzeczywiste słowo kluczowe SQL
        let cleanedStatement = statement.trim();
        
        // Usuń komentarze liniowe z początku
        while (cleanedStatement.startsWith('--')) {
          const newlineIndex = cleanedStatement.indexOf('\n');
          if (newlineIndex === -1) {
            cleanedStatement = ''; // Cały statement to komentarz
            break;
          }
          cleanedStatement = cleanedStatement.substring(newlineIndex + 1).trim();
        }
        
        // Usuń komentarze blokowe z początku
        while (cleanedStatement.startsWith('/*')) {
          const endIndex = cleanedStatement.indexOf('*/');
          if (endIndex === -1) {
            cleanedStatement = ''; // Niepoprawny komentarz blokowy
            break;
          }
          cleanedStatement = cleanedStatement.substring(endIndex + 2).trim();
        }
        
        // Jeśli po usunięciu komentarzy nic nie zostało, pomiń ten statement
        if (!cleanedStatement) {
          continue;
        }
        
        const queryUpper = cleanedStatement.toUpperCase().trim();

        // Prosta walidacja - dozwolone operacje
        const allowedStarts = ['CREATE ', 'ALTER ', 'COMMENT ON '];
        const isAllowed = allowedStarts.some(prefix => queryUpper.startsWith(prefix));

        if (!isAllowed) {
          await client.query("ROLLBACK");
          return {
            content: [{ type: "text", text: `Only CREATE, ALTER, or COMMENT ON queries are allowed with create tool. Disallowed query: ${statement}` }],
            isError: true,
          };
        }

        await client.query(statement);
        results.push(`Query executed successfully: ${statement.substring(0, 50)}...`);
      }

      await client.query("COMMIT");
      return {
        content: [{ type: "text", text: `Schema creation/modification queries executed successfully.\n${results.join('\n')}` }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing create: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "schema") {
    const globPattern = args?.filter as string || "*";
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
               cols.udt_name,
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
            is_nullable: col.is_nullable === 'YES',
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
              const atttypmod = vectorDimensionsResult.rows[0].atttypmod;
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
          primary_keys: [] as any[],
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
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ tables: tablesInfo.length > 0 ? tablesInfo : {} }, null, 2) }],
        isError: false,
      };
    } catch (error: any) {
      throw new Error(`Error executing schema: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "functions") {
    const globPattern = args?.filter as string || "*";
    const format = (args?.format as string || "json").toLowerCase();
    const userPattern = args?.user as string || "postgres";
    
    // Konwertuj glob pattern na SQL LIKE pattern
    let likePattern: string;
    if (globPattern === "*") {
      likePattern = "%"; // Wszystkie funkcje
    } else {
      // Zamień glob wildcards na SQL LIKE wildcards
      likePattern = globPattern
        .replace(/\*/g, "%")     // * -> %
        .replace(/\?/g, "_");     // ? -> _
    }
    
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      
      // Zawsze filtruj po public schema, a filtrowanie właściciela rób w JavaScript
      const functionsQuery = `
SELECT
  p.proname AS function_name,
  n.nspname AS schema_name,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS return_type,
  obj_description(p.oid, 'pg_proc') AS comment,
  l.lanname AS language,
  a.rolname AS owner_name
FROM
  pg_proc p
JOIN
  pg_namespace n ON p.pronamespace = n.oid
JOIN
  pg_language l ON p.prolang = l.oid
JOIN
  pg_authid a ON p.proowner = a.oid
WHERE
  n.nspname = 'public'
  AND p.proname LIKE $1
ORDER BY
  schema_name, function_name`;
      
      const result = await client.query(functionsQuery, [likePattern]);
      await client.query("ROLLBACK");

      // Filtruj właścicieli funkcji za pomocą glob pattern
      const filteredRows = result.rows.filter(row => 
        micromatch.isMatch(row.owner_name, userPattern)
      );

      let outputText: string;

      if (format === "json") {
        outputText = JSON.stringify(filteredRows, null, 2);
      } else if (format === "text") {
        if (filteredRows.length === 0) {
          outputText = `No functions found matching pattern: ${globPattern} and user: ${userPattern}`;
        } else {
          outputText = filteredRows.map(row =>
            `Function: ${row.schema_name}.${row.function_name}\n` +
            `Arguments: ${row.arguments || 'none'}\n` +
            `Returns: ${row.return_type}\n` +
            `Language: ${row.language}\n` +
            `Owner: ${row.owner_name}\n` +
            `Comment: ${row.comment || 'N/A'}\n`
          ).join('\n');
        }
      } else if (format === "markdown") {
        if (filteredRows.length === 0) {
          outputText = `No functions found matching pattern: **${globPattern}** and user: **${userPattern}**`;
        } else {
          const headers = ['function_name', 'schema_name', 'arguments', 'return_type', 'language', 'owner_name', 'comment'];
          const headerLine = `| ${headers.join(" | ")} |`;
          const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
          const dataLines = filteredRows.map(row =>
            `| ${headers.map(header => String(row[header] ?? "N/A")).join(" | ")} |`
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
      throw new Error(`Error executing functions: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "rls_policies") {
    const globPattern = args?.filter as string || "*";
    const format = (args?.format as string || "json").toLowerCase();
    
    // Konwertuj glob pattern na SQL LIKE pattern
    let likePattern: string;
    if (globPattern === "*") {
      likePattern = "%"; // Wszystkie tabele
    } else {
      // Zamień glob wildcards na SQL LIKE wildcards
      likePattern = globPattern
        .replace(/\*/g, "%")     // * -> %
        .replace(/\?/g, "_");     // ? -> _
    }
    
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      
      const rlsQuery = `
SELECT
  p.polname AS policy_name,
  c.relname AS table_name,
  CASE p.polcmd
    WHEN 'r' THEN 'SELECT'
    WHEN 'a' THEN 'ALL'
    WHEN 'w' THEN 'UPDATE'
    WHEN 'd' THEN 'DELETE'
    WHEN 'i' THEN 'INSERT'
    ELSE p.polcmd::text
  END AS command,
  p.polpermissive AS is_permissive,
  pg_get_expr(p.polqual, c.oid) AS using_clause,
  pg_get_expr(p.polwithcheck, c.oid) AS with_check_clause
FROM
  pg_policy p
JOIN
  pg_class c ON p.polrelid = c.oid
JOIN
  pg_namespace n ON c.relnamespace = n.oid
WHERE
  n.nspname = 'public'
  AND c.relname LIKE $1
ORDER BY
  table_name, policy_name`;
      
      const result = await client.query(rlsQuery, [likePattern]);
      await client.query("ROLLBACK");

      let outputText: string;

      if (format === "json") {
        outputText = JSON.stringify(result.rows, null, 2);
      } else if (format === "text") {
        if (result.rows.length === 0) {
          outputText = `No RLS policies found for tables matching pattern: ${globPattern}`;
        } else {
          outputText = result.rows.map(row =>
            `Policy: ${row.policy_name}\nTable: ${row.table_name}\nCommand: ${row.command}\nPermissive: ${row.is_permissive}\nUsing: ${row.using_clause || 'N/A'}\nWith Check: ${row.with_check_clause || 'N/A'}\n`
          ).join('\n');
        }
      } else if (format === "markdown") {
        if (result.rows.length === 0) {
          outputText = `No RLS policies found for tables matching pattern: **${globPattern}**`;
        } else {
          const headers = ['policy_name', 'table_name', 'command', 'is_permissive', 'using_clause', 'with_check_clause'];
          const headerLine = `| ${headers.join(" | ")} |`;
          const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
          const dataLines = result.rows.map(row =>
            `| ${headers.map(header => String(row[header] ?? "N/A")).join(" | ")} |`
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
      throw new Error(`Error executing rls_policies: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "delete") {
    const query = args?.query as string;
    const answer = args?.answer as string;

    if (!query) {
      throw new Error("Missing 'query' argument for delete");
    }
    if (!answer) {
      throw new Error("Missing 'answer' argument for delete. Confirmation is required for destructive operations.");
    }

    if (!validateAnswer(answer)) {
      return {
        content: [{ type: "text", text: "Confirmation failed. Destructive operation denied." }],
        isError: true,
      };
    }

    const statements = splitSqlStatements(query);
    const results: string[] = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const statement of statements) {
        const queryUpper = statement.toUpperCase().trim();

        // Prosta walidacja - dozwolone operacje
        const allowedStarts = ['DELETE ', 'DROP ', 'TRUNCATE '];
        const isAllowed = allowedStarts.some(prefix => queryUpper.startsWith(prefix));

        if (!isAllowed) {
          await client.query("ROLLBACK");
          return {
            content: [{ type: "text", text: `Only DELETE, DROP, or TRUNCATE queries are allowed with delete tool. Disallowed query: ${statement}` }],
            isError: true,
          };
        }

        // DELETE musi mieć WHERE
        if (queryUpper.startsWith("DELETE ") && !queryUpper.includes("WHERE")) {
          await client.query("ROLLBACK");
          return {
            content: [{ type: "text", text: `DELETE queries must include a WHERE clause for safety. Query: ${statement}` }],
            isError: true,
          };
        }

        await client.query(statement);
        results.push(`Query executed successfully: ${statement.substring(0, 50)}...`);
      }

      await client.query("COMMIT");
      return {
        content: [{ type: "text", text: `Destructive queries executed successfully.\n${results.join('\n')}` }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing delete: ${error.message}`);
    } finally {
      client.release();
    }
  }
  
  else if (name === "access") {
    // Dodatkowa walidacja - sprawdź czy narzędzie access jest włączone
    if (!accessFeatureEnabled) {
      throw new Error("Access tool is disabled. Set MCP_POSTGRES_ACCESS_FEATURE=true to enable.");
    }

    const query = args?.query as string;
    const answer = args?.answer as string;

    if (!query) {
      throw new Error("Missing 'query' argument for access");
    }
    if (!answer) {
      throw new Error("Missing 'answer' argument for access. Confirmation is required for permission changes.");
    }

    if (!validateAnswer(answer)) {
      return {
        content: [{ type: "text", text: "Confirmation failed. Permission change denied." }],
        isError: true,
      };
    }

    const statements = splitSqlStatements(query);
    const results: string[] = [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const statement of statements) {
        const queryUpper = statement.toUpperCase().trim();

        // Prosta walidacja - dozwolone operacje
        const allowedStarts = ['GRANT ', 'REVOKE '];
        const isAllowed = allowedStarts.some(prefix => queryUpper.startsWith(prefix));

        if (!isAllowed) {
          await client.query("ROLLBACK");
          return {
            content: [{ type: "text", text: `Only GRANT or REVOKE queries are allowed with access tool. Disallowed query: ${statement}` }],
            isError: true,
          };
        }

        await client.query(statement);
        results.push(`Query executed successfully: ${statement.substring(0, 50)}...`);
      }

      await client.query("COMMIT");
      return {
        content: [{ type: "text", text: `Permission queries executed successfully.\n${results.join('\n')}` }],
        isError: false,
      };
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.warn("Could not roll back transaction on error:", rollbackError);
      }
      throw new Error(`Error executing access: ${error.message}`);
    } finally {
      client.release();
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Nie usuwaj poniższego komentarza
  // Don't change below logging from console.error to console.info, otherwise it will brake MCP stdio protocol
  console.error(`MCP server for PostgreSQL (enhanced) is running using database URL from ${urlSource} and connected via stdio.`);
  console.error(`Access tool (GRANT/REVOKE): ${accessFeatureEnabled ? 'ENABLED' : 'DISABLED'} (controlled by MCP_POSTGRES_ACCESS_FEATURE)`);
}

runServer().catch(error => {
    console.error("Failed to run server:", error);
    process.exit(1);
});
