# Third-party attributions

## Sophos Fusion Tenant Migration Tool

The server's plumbing is copied from the
[Sophos Fusion Tenant Migration Tool](https://github.com/Aaronjacobs000/sophos-tenant-migration-tool)
v0.3.0 (MIT License, same author): the `.env` reader and writer, the network
settings (HOST, ALLOWED_IPS, ALLOWED_HOSTS), the Host and Origin guard, the
client IP guard, the error handler, the JSON body guards, the log with secret
masking, the audit log, safe file saves, the write read-back helpers, and the
dark theme (`frontend/css/base.css`, `frontend/css/components.css`) with its
shared page scripts (`api.js`, `toast.js`, `icons.js`, `ui.js`).

Local changes: one credential at a time (a tenant, or a partner or
organization) instead of a source and a destination; audit entries name a
tenant instead of a side; the accent color.

## sophos-mcp (formerly sophos-central-mcp)

Through the migration tool, these files are vendored from
[sophos-mcp](https://github.com/Aaronjacobs000/sophos-mcp) (MIT License). Each
file's header names the upstream commit and the local changes.

| Upstream path | Local path |
| --- | --- |
| `src/auth/token-manager.ts` | `backend/src/sophos/auth/token-manager.ts` |
| `src/client/sophos-client.ts` | `backend/src/sophos/client/sophos-client.ts` |
| `src/client/tenant-resolver.ts` | `backend/src/sophos/client/tenant-resolver.ts` |
| `src/types/sophos.ts` | `backend/src/sophos/types/sophos.ts` |

## Fonts

`frontend/fonts/` bundles two fonts under the SIL Open Font License 1.1. The
license texts sit next to the font files.

| Font | Source | License file |
| --- | --- | --- |
| Inter (variable, Latin subset) | [rsms/inter](https://github.com/rsms/inter) | `frontend/fonts/OFL-Inter.txt` |
| Geist Mono (variable, Latin subset) | [vercel/geist-font](https://github.com/vercel/geist-font) | `frontend/fonts/OFL-GeistMono.txt` |
