# missiria-rc-connector (MCP server)

Node 22+ server for the MISSIRIA RC Connector: OAuth 2.1 authorization server,
MCP Streamable HTTP endpoint, IMAP/SMTP tools. See the repository root
`README.md` and `docs/INSTALL.md` for installation; this file covers development.

```bash
npm ci
npm test              # vitest
npm run typecheck
npm run build         # → dist/
node dist/cli.js --help
```

Environment variables: see `.env.example`. Tests use an in-memory SQLite
database and a throwaway key pair, no network.
