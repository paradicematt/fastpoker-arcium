# Solana Developer MCP Usage Guidelines

If you are working on a Solana-related project, make frequent use of the following MCP tools to accomplish your goals.

## Available Tools

The following Solana tools are at your disposal via the `solanaMcp` MCP server:

- **Solana Expert: Ask For Help** — Use this tool to ask detailed questions about Solana (how-to, concepts, APIs, SDKs, errors). Provide as much context as possible when using it.
- **Solana Documentation Search** — Use this tool to search the Solana documentation corpus for relevant information based on a query.
- **Ask Solana Anchor Framework Expert** — Use this tool for any questions specific to the Anchor Framework, including its APIs, SDKs, and error handling.

## Setup

The Solana Developer MCP server must be added to Windsurf's MCP settings:

```json
{
  "mcpServers": {
    "solanaMcp": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.solana.com/mcp"]
    }
  }
}
```

To add it: Open Windsurf Settings (Ctrl+Shift+P → "Cascade: Configure MCP Servers") and add the above configuration.
