#!/usr/bin/env node

/*
 * Enhanced Filesystem MCP Server with Advanced Features
 * 
 * Features:
 * 1. Parameter Validation - Clear error messages for common mistakes
 * 2. Developer-Friendly Excludes - Automatically filters out common dev files/folders
 * 3. Flexible Include/Exclude System - Support for both legacy and new argument formats
 * 
 * Usage:
 * New format:   node index.ts --include /projects --exclude .env private.txt
 * Legacy format: node index.ts /projects (with warnings)
 * 
 * Examples of validation:
 * ✅ Correct: { "path": "/some/valid/path" }
 * ❌ Wrong:   { "file_path": "/some/path" } → Error: Use 'path' instead of 'file_path'
 * ❌ Wrong:   { "path": "" } → Error: Path cannot be empty
 * 
 * Default excludes: .DS_Store, .git, __pycache__, .venv, venv, node_modules, dist, build, etc.
 * Custom excludes: Add your own patterns with --exclude
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';

// Command line argument parsing with --include and --exclude support
interface ParsedArgs {
  include: string[];
  exclude: string[];
}

// Default exclude patterns for developer environments
const defaultExcludePatterns = [
  '.DS_Store',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  '.idea',
  '.vscode',
  '*.pyc',
  '.pytest_cache',
  '.coverage',
  'coverage.xml',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'target',
  'bin'
];

function parseArguments(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    include: [],
    exclude: []
  };
  
  if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem --include <dir1> [dir2...] [--exclude <pattern1> [pattern2...]]");
    console.error("       mcp-server-filesystem --list-excludes");
    console.error("Example: mcp-server-filesystem --include /projects --exclude .DS_Store .git __pycache__ .venv venv node_modules dist build");
    process.exit(1);
  }
  
  // Handle --list-excludes flag
  if (args.includes('--list-excludes')) {
    console.log("Default exclude patterns:");
    defaultExcludePatterns.forEach(pattern => console.log(`  ${pattern}`));
    process.exit(0);
  }
  
  let currentFlag: 'include' | 'exclude' | null = null;
  
  // Handle legacy format (no flags, just directories)
  if (!args.includes('--include') && !args.includes('--exclude')) {
    console.warn("Legacy format detected. Please use --include flag. Converting to new format.");
    result.include = args;
    return result;
  }
  
  for (const arg of args) {
    if (arg === '--include') {
      currentFlag = 'include';
    } else if (arg === '--exclude') {
      currentFlag = 'exclude';
    } else if (currentFlag) {
      result[currentFlag].push(arg);
    } else {
      console.error(`Unexpected argument: ${arg}. Use --include or --exclude flags.`);
      process.exit(1);
    }
  }
  
  if (result.include.length === 0) {
    console.error("At least one --include directory must be specified.");
    process.exit(1);
  }
  
  return result;
}

const args = process.argv.slice(2);
const parsedArgs = parseArguments(args);

// Combine user-specified excludes with defaults
const globalExcludePatterns = [...defaultExcludePatterns, ...parsedArgs.exclude];

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = parsedArgs.include.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(parsedArgs.include.map(async (dir) => {
  try {
    const stats = await fs.stat(expandHome(dir));
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Parameter validation utilities
function validateAndParseArgs<T>(schema: z.ZodType<T>, args: any, toolName: string): T {
  // Check for common parameter name mistakes
  const commonMistakes = {
    'file_path': 'path',
    'filepath': 'path',
    'filename': 'path',
    'directory': 'path',
    'dir': 'path'
  };

  // Check if user provided wrong parameter names
  if (args && typeof args === 'object') {
    for (const [wrongName, correctName] of Object.entries(commonMistakes)) {
      if (wrongName in args && !(correctName in args)) {
        throw new Error(
          `Invalid parameter name for ${toolName}: Use '${correctName}' instead of '${wrongName}'. ` +
          `Received: ${JSON.stringify(args)}`
        );
      }
    }
  }

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const errorDetails = parsed.error.errors.map(err => 
      `${err.path.join('.')}: ${err.message}`
    ).join(', ');
    
    throw new Error(
      `Invalid arguments for ${toolName}. Expected parameters: ${getExpectedParams(schema)}. ` +
      `Errors: ${errorDetails}. Received: ${JSON.stringify(args)}`
    );
  }

  return parsed.data;
}

function getExpectedParams(schema: z.ZodType<any>): string {
  try {
    if (schema instanceof z.ZodObject) {
      return Object.keys(schema.shape).join(', ');
    }
  } catch {
    // Fallback if schema introspection fails
  }
  return 'see tool description';
}

// Helper function to check if path should be excluded
function shouldExcludePath(filePath: string, basePath: string = ''): boolean {
  // Get relative path for pattern matching
  const relativePath = basePath ? path.relative(basePath, filePath) : path.basename(filePath);
  
  return globalExcludePatterns.some(pattern => {
    // Direct name match
    if (relativePath === pattern || path.basename(filePath) === pattern) {
      return true;
    }
    
    // Glob pattern match
    const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
    return minimatch(relativePath, globPattern, { dot: true }) ||
           minimatch(path.basename(filePath), pattern, { dot: true });
  });
}

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  // Additional input validation
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error(`Invalid path: Path must be a non-empty string. Received: ${JSON.stringify(requestedPath)}`);
  }
  
  if (requestedPath.trim() === '') {
    throw new Error('Invalid path: Path cannot be empty or whitespace only');
  }

  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string().min(1, 'Path cannot be empty')),
});

const WriteFileArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty').optional(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty').optional(),
});

const MoveFileArgsSchema = z.object({
  source: z.string().min(1, 'Source path cannot be empty'),
  destination: z.string().min(1, 'Destination path cannot be empty'),
});

const SearchFilesArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty').optional(), // Zmieniono na opcjonalne
  pattern: z.string().min(1, 'Search pattern cannot be empty'),
  excludePatterns: z.array(z.string()).optional().default([]),
  maxResults: z.number().int().positive().optional().describe('Maximum number of results to return (default: unlimited)'),
  findFirst: z.boolean().optional().default(false).describe('Stop after finding the first match (fastest option)')
});

const GetFileInfoArgsSchema = z.object({
  path: z.string().min(1, 'Path cannot be empty'),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Server setup
const server = new Server(
  {
    name: "secure-filesystem-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = [],
  maxResults?: number,
  findFirst: boolean = false
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [rootPath]; // Initialize queue for BFS
  
  // Combine local excludes with global excludes
  const allExcludePatterns = [...globalExcludePatterns, ...excludePatterns];
  
  // Early exit conditions
  if (findFirst && maxResults === undefined) {
    maxResults = 1;
  }

  while (queue.length > 0) {
    // Check if we've reached our limit
    if (maxResults && results.length >= maxResults) {
      break; // Stop searching
    }

    const currentPath = queue.shift()!; // Dequeue the current directory

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        try {
          // Validate each path before processing
          await validatePath(fullPath);

          // Check if path matches any exclude pattern (global + local)
          const relativePath = path.relative(rootPath, fullPath);
          const shouldExclude = allExcludePatterns.some(excludePattern => {
            const globPattern = excludePattern.includes('*') ? excludePattern : `**/${excludePattern}/**`;
            return minimatch(relativePath, globPattern, { dot: true }) ||
                   minimatch(path.basename(fullPath), excludePattern, { dot: true });
          });

          if (shouldExclude) {
            continue;
          }

          if (entry.name.toLowerCase().includes(pattern.toLowerCase())) { // Usunięto entry.isFile()
            results.push(fullPath);
            
            // If findFirst is true, stop immediately after first match
            if (findFirst) {
              return results; // Return immediately
            }
            
            // If we've reached maxResults, stop
            if (maxResults && results.length >= maxResults) {
              return results; // Return immediately
            }
          }

          if (entry.isDirectory()) {
            queue.push(fullPath); // Enqueue directories for later processing
          }
        } catch (error) {
          // Skip invalid paths during search
          continue;
        }
      }
    } catch (error) {
      // Skip directories that can't be read
      console.warn(`Skipping directory ${currentPath}: ${error}`);
    }
  }

  return results;
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "read_file",
        description:
          "Read the complete contents of a file from the file system. " +
          "Handles various text encodings and provides detailed error messages " +
          "if the file cannot be read. Use this tool when you need to examine " +
          "the contents of a single file. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "read_multiple_files",
        description:
          "Read the contents of multiple files simultaneously. This is more " +
          "efficient than reading files one by one when you need to analyze " +
          "or compare multiple files. Each file's content is returned with its " +
          "path as a reference. Failed reads for individual files won't stop " +
          "the entire operation. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description:
          "Create a new file or completely overwrite an existing file with new content. " +
          "Use with caution as it will overwrite existing files without warning. " +
          "Handles text content with proper encoding. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "edit_file",
        description:
          "Make line-based edits to a text file. Each edit replaces exact line sequences " +
          "with new content. Returns a git-style diff showing the changes made. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description:
          "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "Get a detailed listing of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "directory_tree",
        description:
            "Get a recursive tree view of files and directories as a JSON structure. " +
            "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
            "Files have no children array, while directories always have a children array (which may be empty). " +
            "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
      },
      {
        name: "move_file",
        description:
          "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories. " +
          "Options: Use 'findFirst: true' for quick existence checks, or 'maxResults' to limit output.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description:
          "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "list_allowed_directories",
        description:
          "Returns the list of directories that this server is allowed to access. " +
          "Use this to understand which directories are available before trying to access files.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "read_file": {
        const parsed = validateAndParseArgs(ReadFileArgsSchema, args, 'read_file');
        const validPath = await validatePath(parsed.path);
        const content = await fs.readFile(validPath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "read_multiple_files": {
        const parsed = validateAndParseArgs(ReadMultipleFilesArgsSchema, args, 'read_multiple_files');
        const results = await Promise.all(
          parsed.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(filePath);
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          }),
        );
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }

      case "write_file": {
        const parsed = validateAndParseArgs(WriteFileArgsSchema, args, 'write_file');
        const validPath = await validatePath(parsed.path);
        await fs.writeFile(validPath, parsed.content, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.path}` }],
        };
      }

      case "edit_file": {
        const parsed = validateAndParseArgs(EditFileArgsSchema, args, 'edit_file');
        const validPath = await validatePath(parsed.path);
        const result = await applyFileEdits(validPath, parsed.edits as Array<{oldText: string, newText: string}>, parsed.dryRun);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "create_directory": {
        const parsed = validateAndParseArgs(CreateDirectoryArgsSchema, args, 'create_directory');
        const validPath = await validatePath(parsed.path);
        await fs.mkdir(validPath, { recursive: true });
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
        };
      }

      case "list_directory": {
        const parsed = validateAndParseArgs(ListDirectoryArgsSchema, args, 'list_directory');
        const targetPath = parsed.path ?? allowedDirectories[0]; // Użyj pierwszej dozwolonej ścieżki jako domyślnej
        if (!targetPath) {
          throw new Error("No allowed directories configured for listing.");
        }
        const validPath = await validatePath(targetPath);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        
        // Filter out excluded patterns
        const filteredEntries = entries.filter(entry => {
          const fullPath = path.join(validPath, entry.name);
          return !shouldExcludePath(fullPath, validPath);
        });
        
        const formatted = filteredEntries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

        case "directory_tree": {
            const parsed = validateAndParseArgs(DirectoryTreeArgsSchema, args, 'directory_tree');
            const targetPath = parsed.path ?? allowedDirectories[0]; // Użyj pierwszej dozwolonej ścieżki jako domyślnej
            if (!targetPath) {
              throw new Error("No allowed directories configured for tree view.");
            }

            interface TreeEntry {
                name: string;
                type: 'file' | 'directory';
                children?: TreeEntry[];
            }

            async function buildTree(currentPath: string): Promise<TreeEntry[]> {
                const validPath = await validatePath(currentPath);
                const entries = await fs.readdir(validPath, {withFileTypes: true});
                const result: TreeEntry[] = [];

                for (const entry of entries) {
                    const fullPath = path.join(currentPath, entry.name);
                    
                    // Skip excluded patterns
                    if (shouldExcludePath(fullPath, validPath)) {
                        continue;
                    }
                    
                    const entryData: TreeEntry = {
                        name: entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file'
                    };

                    if (entry.isDirectory()) {
                        try {
                            entryData.children = await buildTree(fullPath);
                        } catch (error) {
                            // Skip directories that can't be read
                            console.warn(`Skipping directory ${fullPath}: ${error}`);
                            continue;
                        }
                    }

                    result.push(entryData);
                }

                return result;
            }

            const treeData = await buildTree(targetPath);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(treeData, null, 2)
                }],
            };
        }

      case "move_file": {
        const parsed = validateAndParseArgs(MoveFileArgsSchema, args, 'move_file');
        const validSourcePath = await validatePath(parsed.source);
        const validDestPath = await validatePath(parsed.destination);
        await fs.rename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
        };
      }

      case "search_files": {
        const parsed = validateAndParseArgs(SearchFilesArgsSchema, args, 'search_files');
        const targetPath = parsed.path ?? allowedDirectories[0]; // Użyj pierwszej dozwolonej ścieżki jako domyślnej
        if (!targetPath) {
          throw new Error("No allowed directories configured for searching.");
        }
        const validPath = await validatePath(targetPath);
        const results = await searchFiles(
          validPath, 
          parsed.pattern, 
          parsed.excludePatterns, 
          parsed.maxResults, 
          parsed.findFirst
        );
        
        const responseText = results.length > 0 
          ? results.join("\n") + (parsed.maxResults && results.length >= parsed.maxResults ? `\n\n(Limited to ${parsed.maxResults} results)` : '')
          : "No matches found";
          
        return {
          content: [{ type: "text", text: responseText }],
        };
      }

      case "get_file_info": {
        const parsed = validateAndParseArgs(GetFileInfoArgsSchema, args, 'get_file_info');
        const validPath = await validatePath(parsed.path);
        const info = await getFileStats(validPath);
        return {
          content: [{ type: "text", text: Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n") }],
        };
      }

      case "list_allowed_directories": {
        const excludeInfo = globalExcludePatterns.length > 0 
          ? `\n\nGlobal exclude patterns (${globalExcludePatterns.length} total):\n${globalExcludePatterns.slice(0, 20).join('\n')}${globalExcludePatterns.length > 20 ? '\n... and more' : ''}` 
          : '';
        return {
          content: [{
            type: "text",
            text: `Allowed directories:\n${allowedDirectories.join('\n')}${excludeInfo}`
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Enhanced MCP Filesystem Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
  console.error("Global exclude patterns:", globalExcludePatterns.slice(0, 10).join(', ') + (globalExcludePatterns.length > 10 ? ` and ${globalExcludePatterns.length - 10} more...` : ''));
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
