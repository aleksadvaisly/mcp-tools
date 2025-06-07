# PostgreSQL Enhanced

A Model Context Protocol server that provides comprehensive access to PostgreSQL databases. This server enables LLMs to inspect database schemas and execute various SQL operations with proper security controls.

## Components

### Tools

- **select**
  - Execute parameterized SELECT queries against the database
  - Input: `query` (string), `values` (array), `format` (json/text/markdown)
  - Supports vector similarity functions for embedding columns
  - All queries executed within READ ONLY transaction

- **update**
  - Execute parameterized INSERT, UPDATE queries, and DO blocks
  - Input: `query` (string), `values` (array)
  - Supports WITH clauses for complex operations
  - Supports anonymous PL/pgSQL blocks with DO statement

- **create**
  - Perform schema creation and modification operations
  - Supports: CREATE (tables, indexes, views, functions, triggers), ALTER, COMMENT ON
  - Input: `query` (string) - supports multiple statements with semicolons
  - Batch operations supported

- **schema**
  - Retrieve comprehensive database schema information
  - Returns: tables, columns, indexes, triggers, foreign keys, primary keys
  - Input: `glob_pattern` (string) - filter table names with glob patterns
  - Includes vector dimension information for pgvector columns

- **delete**
  - Perform destructive operations: DELETE (with WHERE), DROP, TRUNCATE
  - Input: `query` (string), `answer` (string) - confirmation required
  - DELETE statements must include WHERE clause for safety
  - Supports multiple statements with semicolons

- **access** ⚠️ *Optional - requires MCP_POSTGRES_ACCESS_FEATURE=true*
  - Manage database permissions: GRANT and REVOKE statements
  - Input: `query` (string), `answer` (string) - confirmation required
  - High-security operations with strict access control
  - Supports multiple statements with semicolons

### Resources

The server provides schema information for each table in the database:

- **Table Schemas** (`postgres://<host>/<table>/schema`)
  - JSON schema information for each table
  - Includes column names and data types
  - Automatically discovered from database metadata

## Environment Variables

- `POSTGRES_URL` - Database connection string (alternative to command line argument)
- `MCP_POSTGRES_ACCESS_FEATURE` - Set to `true` to enable access tool (GRANT/REVOKE operations)

## Configuration

### Usage with Claude Desktop

To use this server with the Claude Desktop app, add the following configuration to the "mcpServers" section of your `claude_desktop_config.json`:

### Docker

* when running docker on macos, use host.docker.internal if the server is running on the host network (eg localhost)
* username/password can be added to the postgresql url with `postgresql://user:password@host:port/db-name`

```json
{
  "mcpServers": {
    "postgres": {
      "command": "docker",
      "args": [
        "run", 
        "-i", 
        "--rm", 
        "-e", "MCP_POSTGRES_ACCESS_FEATURE=true",
        "mcp/postgres", 
        "postgresql://host.docker.internal:5432/mydb"
      ]
    }
  }
}
```

### NPX

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://localhost/mydb"
      ],
      "env": {
        "MCP_POSTGRES_ACCESS_FEATURE": "true"
      }
    }
  }
}
```

Replace `/mydb` with your database name.

### Usage with VS Code

For quick installation, use one of the one-click install buttons below...

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=postgres&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22pg_url%22%2C%22description%22%3A%22PostgreSQL%20URL%20(e.g.%20postgresql%3A%2F%2Fuser%3Apass%40localhost%3A5432%2Fmydb)%22%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-postgres%22%2C%22%24%7Binput%3Apg_url%7D%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-NPM-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=postgres&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22pg_url%22%2C%22description%22%3A%22PostgreSQL%20URL%20(e.g.%20postgresql%3A%2F%2Fuser%3Apass%40localhost%3A5432%2Fmydb)%22%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-postgres%22%2C%22%24%7Binput%3Apg_url%7D%22%5D%7D&quality=insiders)

[![Install with Docker in VS Code](https://img.shields.io/badge/VS_Code-Docker-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=postgres&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22pg_url%22%2C%22description%22%3A%22PostgreSQL%20URL%20(e.g.%20postgresql%3A%2F%2Fuser%3Apass%40host.docker.internal%3A5432%2Fmydb)%22%7D%5D&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22--rm%22%2C%22mcp%2Fpostgres%22%2C%22%24%7Binput%3Apg_url%7D%22%5D%7D) [![Install with Docker in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Docker-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=postgres&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22pg_url%22%2C%22description%22%3A%22PostgreSQL%20URL%20(e.g.%20postgresql%3A%2F%2Fuser%3Apass%40host.docker.internal%3A5432%2Fmydb)%22%7D%5D&config=%7B%22command%22%3A%22docker%22%2C%22args%22%3A%5B%22run%22%2C%22-i%22%2C%22--rm%22%2C%22mcp%2Fpostgres%22%2C%22%24%7Binput%3Apg_url%7D%22%5D%7D&quality=insiders)

For manual installation, add the following JSON block to your User Settings (JSON) file in VS Code. You can do this by pressing `Ctrl + Shift + P` and typing `Preferences: Open User Settings (JSON)`.

Optionally, you can add it to a file called `.vscode/mcp.json` in your workspace. This will allow you to share the configuration with others.

> Note that the `mcp` key is not needed in the `.vscode/mcp.json` file.

### Docker

**Note**: When using Docker and connecting to a PostgreSQL server on your host machine, use `host.docker.internal` instead of `localhost` in the connection URL.

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "pg_url",
        "description": "PostgreSQL URL (e.g. postgresql://user:pass@host.docker.internal:5432/mydb)"
      }
    ],
    "servers": {
      "postgres": {
        "command": "docker",
        "args": [
          "run",
          "-i",
          "--rm",
          "-e", "MCP_POSTGRES_ACCESS_FEATURE=true",
          "mcp/postgres",
          "${input:pg_url}"
        ]
      }
    }
  }
}
```

### NPX

```json
{
  "mcp": {
    "inputs": [
      {
        "type": "promptString",
        "id": "pg_url",
        "description": "PostgreSQL URL (e.g. postgresql://user:pass@localhost:5432/mydb)"
      }
    ],
    "servers": {
      "postgres": {
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-postgres",
          "${input:pg_url}"
        ],
        "env": {
          "MCP_POSTGRES_ACCESS_FEATURE": "true"
        }
      }
    }
  }
}
```

## Usage Examples

### Basic Operations

```javascript
// Select with parameters
{
  "tool": "select",
  "arguments": {
    "query": "SELECT * FROM users WHERE age > $1 AND city = $2 LIMIT $3",
    "values": [25, "Warsaw", 10],
    "format": "json"
  }
}

// Insert with batch operations
{
  "tool": "update", 
  "arguments": {
    "query": "INSERT INTO articles (title, content) VALUES ($1, $2); UPDATE stats SET count = count + 1;",
    "values": ["New Article", "Article content..."]
  }
}

// Anonymous PL/pgSQL block
{
  "tool": "update",
  "arguments": {
    "query": "DO $ DECLARE entry_record RECORD; BEGIN FOR entry_record IN SELECT id, content FROM application_entries WHERE content IS NOT NULL LOOP PERFORM insert_application_entries_embed(entry_record.id, entry_record.content); END LOOP; END $"
  }
}

// Create function and trigger
{
  "tool": "create",
  "arguments": {
    "query": "CREATE OR REPLACE FUNCTION update_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER update_users_timestamp BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp();"
  }
}
```

### Security Features

- **Parameterized queries** prevent SQL injection
- **Transaction safety** with automatic rollback on errors
- **Confirmation required** for destructive operations
- **Access control** via environment variables
- **WHERE clause enforcement** for DELETE operations

## Building

Docker:

```sh
docker build -t mcp/postgres -f src/postgres/Dockerfile . 
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
