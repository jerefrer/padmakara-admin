# CLAUDE.md - Padmakara API (Hono Backend)

This file provides guidance to Claude Code when working with the **padmakara-api** backend - a modern replacement for the Django backend built with Hono, Drizzle ORM, and Bun.

## Project Overview

**Padmakara API** is a high-performance TypeScript backend for the Padmakara Buddhist retreat system. It provides REST APIs for mobile/web clients to access retreat recordings, track progress, manage user authentication, and download content for offline use.

### Technology Stack

- **Runtime**: Bun (fast JavaScript runtime with built-in TypeScript support)
- **Framework**: Hono (lightweight, ultra-fast web framework)
- **Database**: PostgreSQL with Drizzle ORM
- **Storage**: AWS S3 for audio files, PDFs, and generated ZIPs
- **Authentication**: JWT tokens with bcryptjs password hashing
- **Validation**: Zod v4 for request/response validation
- **Testing**: Vitest with mocked database for unit tests
- **Admin UI**: React-admin with Vite for content management

### System Architecture

```
┌─────────────────────┐    HTTP/REST    ┌─────────────────────┐
│   Frontend Apps     │◄───────────────►│   Hono API Server   │
│                     │                 │                     │
│ React Native/Expo   │                 │ - Auth (JWT)        │
│ React Admin UI      │                 │ - Events/Sessions   │
└─────────────────────┘                 │ - Progress Tracking │
                                        │ - ZIP Downloads     │
                                        └─────────────────────┘
                                                   │
                                                   │ Drizzle ORM
                                                   ▼
                                        ┌─────────────────────┐
                                        │    PostgreSQL       │
                                        │ - Users/Groups      │
                                        │ - Events/Sessions   │
                                        │ - User Progress     │
                                        │ - Download Requests │
                                        └─────────────────────┘
                                                   │
                                                   │ S3 Storage
                                                   ▼
                                        ┌─────────────────────┐
                                        │    Amazon S3        │
                                        │ - Audio Files (.mp3)│
                                        │ - PDF Transcripts   │
                                        │ - Generated ZIPs    │
                                        └─────────────────────┘
```

## Development Commands

### Setup & Installation

```bash
# Install dependencies
bun install

# Setup database (create tables, run migrations)
bun db:push                    # Push schema changes to database
bun db:generate                # Generate migration files
bun db:migrate                 # Run migrations
bun db:studio                  # Open Drizzle Studio (database GUI)
```

### Development Workflow

```bash
# Start API server (auto-reload on changes)
bun run dev                    # API server on http://localhost:3000

# Start React-admin UI (separate terminal)
bun run dev:admin              # Admin UI on http://localhost:5173

# Run tests
bun test                       # Run all tests once
bun test:watch                 # Run tests in watch mode

# Type checking
bun run typecheck              # Run TypeScript compiler checks
```

### Database Operations

```bash
# Schema management
bun db:push                    # Direct schema push (development)
bun db:generate                # Generate SQL migrations
bun db:migrate                 # Apply migrations (production)
bun db:studio                  # Visual database browser

# Data seeding
bun db:seed                    # Import data from CSV files
bun migrate:wix                # Migrate data from old Django backend
```

### Important Notes

- **Zoxide compatibility**: Use `sh -c 'cd /path && command'` pattern when running commands from subdirectories
- **Vitest + Zod v4**: Requires `deps.inline: ["zod"]` in vitest.config.ts
- **Database mocking**: Use `vi.mock("../../src/db/index.ts")` pattern with chainable mock methods
- **Never use `cd` directly**: The user has zoxide installed which hijacks the cd command

## Project Structure

```
padmakara-api/
├── src/
│   ├── index.ts                 # Application entry point
│   ├── db/
│   │   ├── index.ts            # Database client setup
│   │   └── schema/             # Database schema definitions
│   │       ├── users.ts        # User, roles, group memberships
│   │       ├── retreats.ts     # Events, sessions, tracks, places, teachers
│   │       ├── content.ts      # User progress, bookmarks, notes
│   │       ├── download-requests.ts  # ZIP download tracking
│   │       └── index.ts        # Schema exports
│   ├── routes/
│   │   ├── index.ts            # Route registration
│   │   ├── auth.ts             # Authentication endpoints
│   │   ├── events.ts           # Event listing, detail, download requests
│   │   ├── content.ts          # Progress, bookmarks, presigned URLs
│   │   ├── downloads.ts        # ZIP download status & download
│   │   └── admin/              # React-admin data provider routes
│   ├── services/
│   │   ├── auth.ts             # JWT token generation/verification
│   │   ├── s3.ts               # AWS S3 operations (upload, download, presigned URLs)
│   │   ├── track-parser.ts     # Audio filename parsing logic
│   │   └── zip-generator.ts    # Retreat ZIP generation with progress tracking
│   ├── middleware/
│   │   └── auth.ts             # JWT authentication middleware
│   ├── lib/
│   │   └── errors.ts           # AppError class & error handling
│   ├── scripts/
│   │   ├── seed-from-csv.ts    # CSV data import
│   │   └── migrate-from-wix.ts # Django backend migration
│   └── types/
│       └── index.ts            # Shared TypeScript types
├── tests/
│   ├── routes/                 # Route/endpoint tests
│   └── services/               # Service layer tests
│       └── track-parser.test.ts
├── admin/                      # React-admin UI (separate Vite app)
├── drizzle.config.ts          # Drizzle ORM configuration
├── vitest.config.ts           # Vitest test configuration
├── tsconfig.json              # TypeScript configuration
└── package.json               # Dependencies & scripts
```

## Database Schema

### Core Tables

**users** - User accounts with Buddhist-specific fields
- Fields: id, email, password (bcrypt hashed), firstName, lastName, dharmaName, role (user|admin|superadmin), subscriptionStatus, subscriptionExpiry
- Relations: groupMemberships, userProgress, bookmarks, downloadRequests

**retreatGroups** - Communities that users belong to
- Fields: id, name, description
- Relations: userGroupMemberships, eventRetreatGroups

**events** (formerly "retreats") - Bi-annual retreat gatherings
- Fields: id, eventCode (unique), titleEn, titlePt, description, startDate, endDate, status (draft|published|archived)
- Relations: sessions, eventRetreatGroups, eventTeachers, eventPlaces

**sessions** - Daily recordings within events
- Fields: id, eventId, sessionNumber, titleEn, titlePt, sessionDate, timePeriod (morning|afternoon|evening)
- Relations: event, tracks

**tracks** - Individual audio files
- Fields: id, sessionId, trackNumber, titleEn, titlePt, duration, s3Key, language (en|pt|tib)
- Relations: session, userProgress, bookmarks

**downloadRequests** - ZIP generation tracking
- Fields: id (UUID), userId, eventId, status (pending|processing|ready|failed|expired), fileSize, downloadUrl, s3Key, totalFiles, processedFiles, progressPercent
- Relations: user, event

### Key Relationships

```
retreatGroups ←→ users (many-to-many via userGroupMemberships)
retreatGroups ←→ events (many-to-many via eventRetreatGroups)
events → sessions → tracks (hierarchical one-to-many)
users → downloadRequests → events (user downloads event ZIPs)
users → userProgress → tracks (track listening progress)
users → bookmarks → tracks (track position bookmarks)
```

## API Endpoints

### Authentication

- `POST /api/auth/register` - Create new user account
- `POST /api/auth/login` - Login with email/password, returns JWT token
- `GET /api/auth/me` - Get current user profile (authenticated)

### Events & Sessions

- `GET /api/events` - List events accessible to user (filtered by group membership)
- `GET /api/events/:id` - Event details with sessions and tracks
- `POST /api/events/:id/request-download` - Request ZIP download for event

### Downloads (ZIP Generation)

- `POST /api/events/:id/request-download` - Create download request, returns `request_id`
- `GET /api/download-requests/:id/status` - Poll download status (pending|processing|ready|failed|expired)
- `GET /api/download-requests/:id/download` - Get presigned download URL (when ready)

**Download Flow:**
1. Client POSTs to `/api/events/:id/request-download`
2. Server creates downloadRequest, returns `request_id` immediately
3. ZIP generation starts in background (fire-and-forget async)
4. Client polls `/api/download-requests/:id/status` every 5s
5. When status = "ready", client GETs `/api/download-requests/:id/download` for presigned URL
6. Client downloads ZIP from presigned URL (1 hour expiry)
7. Generated ZIPs expire after 24 hours

### Content & Progress

- `GET /api/content/presigned-url/:trackId` - Get presigned URL for audio playback
- `GET /api/content/progress` - Get user's progress across all tracks
- `POST /api/content/progress/:trackId` - Update listening progress for a track
- `GET /api/content/bookmarks` - Get user's bookmarks
- `POST /api/content/bookmarks` - Create bookmark at track position

## Key Features & Implementation Patterns

### 1. Authentication & Authorization

**JWT Tokens:**
- Generated with `jsonwebtoken` library
- Payload: `{ sub: userId, email, role }`
- 7-day expiry for access tokens
- Verified via `authMiddleware` on protected routes

**Authorization:**
- Group-based access: Users can only access events for groups they belong to
- Admin/superadmin: Can access all events regardless of group membership
- Each endpoint verifies user has access to requested resources

### 2. Database Mocking for Tests

**Pattern:**
```typescript
vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ /* mock data */ }])),
      })),
    })),
    query: {
      events: {
        findFirst: vi.fn(() => Promise.resolve({ /* mock event */ })),
        findMany: vi.fn(() => Promise.resolve([{ /* mock events */ }])),
      },
    },
  },
}));
```

**Best Practices:**
- Mock at the `db` level, not individual queries
- Use chainable mock methods for query builder pattern
- Return Promises for async operations
- Test both success and error cases

### 3. Error Handling

**AppError Class:**
```typescript
new AppError(statusCode: number, message: string, code?: string)
// or use static helpers:
AppError.badRequest(message, code)
AppError.unauthorized(message)
AppError.forbidden(message)
AppError.notFound(message)
AppError.conflict(message)
```

**Error Handler Middleware:**
- Catches all errors in routes
- Returns consistent JSON error responses
- Handles Zod validation errors specially
- PostgreSQL unique constraint violations → 409 Conflict

### 4. S3 Integration

**Stream-based Operations:**
- Use `getObjectStream()` for downloading from S3
- Use `uploadStream()` for streaming uploads (multipart for large files)
- Generate presigned URLs for client-side downloads/uploads
- Organize files by event: `eventCode/sessionTitle/trackNumber.mp3`

**ZIP Generation:**
- Stream-based to minimize memory usage
- Download tracks from S3 → pipe to archiver → upload to S3
- Progress tracking: Update database every 5 files
- Background processing: Fire-and-forget async pattern

### 5. Zod Validation

**Important Notes:**
- Using Zod v4 (not v3)
- Import as `import { z } from "zod"` (not `"zod/v4"`)
- Requires `deps.inline: ["zod"]` in vitest.config.ts for tests
- Use `.safeParse()` for validation, check `.success` before accessing `.data`

**Pattern:**
```typescript
const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const result = schema.safeParse(data);
if (!result.success) {
  throw AppError.badRequest("Validation failed", "VALIDATION_ERROR");
}
const validated = result.data;
```

## Testing Requirements

**⚠️ CRITICAL: All features MUST have comprehensive tests**

### Testing Standards

1. **Unit Tests Required For:**
   - All service functions (auth, S3, parsers, ZIP generation)
   - All route handlers (auth, events, content, downloads)
   - Error handling paths (invalid input, unauthorized access, not found)
   - Database queries (using mocked db)

2. **Test Coverage Goals:**
   - Minimum 80% code coverage for all routes and services
   - 100% coverage for critical paths (authentication, authorization, payments)
   - All error cases must be tested

3. **Test Organization:**
   - Place tests in `tests/` directory mirroring `src/` structure
   - Name test files as `*.test.ts`
   - Use `describe` blocks for logical grouping
   - Use descriptive test names: `it("returns 404 when event not found")`

4. **Test Patterns:**

```typescript
// Mock database
vi.mock("../../src/db/index.ts", () => ({
  db: { /* mock implementation */ }
}));

// Mock S3 service
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://...")),
}));

// Test route handler
describe("POST /api/auth/login", () => {
  it("returns JWT token for valid credentials", async () => {
    // Setup mocks
    // Make request
    // Assert response
  });

  it("returns 401 for invalid password", async () => {
    // Test error case
  });
});
```

5. **What to Test:**
   - ✅ Happy path (successful requests)
   - ✅ Validation errors (invalid input)
   - ✅ Authorization errors (missing/invalid token, forbidden)
   - ✅ Not found errors (invalid IDs)
   - ✅ Edge cases (empty results, null values)
   - ✅ Database errors (connection failures, constraint violations)

### Running Tests

```bash
# Run all tests once
bun test

# Watch mode (auto-rerun on changes)
bun test:watch

# Run specific test file
bun test tests/routes/auth.test.ts

# Run with coverage
bun test --coverage
```

## Code Style & Conventions

### TypeScript Standards

- **Strict mode enabled**: No implicit any, strict null checks
- **Use interfaces** for object shapes, **types** for unions/intersections
- **Explicit return types** for functions (except obvious cases)
- **No `any` types** - use `unknown` and type guards instead

### Naming Conventions

- **Files**: kebab-case (`track-parser.ts`, `download-requests.ts`)
- **Functions/variables**: camelCase (`getUserById`, `downloadUrl`)
- **Classes**: PascalCase (`AppError`, `AuthMiddleware`)
- **Constants**: UPPER_SNAKE_CASE (`AWS_BUCKET_NAME`, `JWT_SECRET`)
- **Database tables**: snake_case (`user_progress`, `download_requests`)
- **TypeScript types**: PascalCase (`AuthUser`, `DownloadRequest`)

### Import Organization

```typescript
// 1. External packages
import { Hono } from "hono";
import { z } from "zod";

// 2. Database & schema
import { db } from "../db/index.ts";
import { events, sessions } from "../db/schema/retreats.ts";

// 3. Services & utilities
import { authMiddleware, getUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";

// 4. Types
import type { AuthUser } from "../types/index.ts";
```

### Error Handling

- **Always use AppError** for expected errors
- **Let unexpected errors bubble** to error handler middleware
- **Provide meaningful error codes** for client-side handling
- **Never expose sensitive details** in error messages

### Database Queries

- **Use Drizzle query builder** for type safety
- **Use `db.query` for relations** (nested with/include)
- **Use `db.select().from()` for simple queries**
- **Always handle null results** from `.findFirst()`

## Environment Variables

Required environment variables (set in `.env`):

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/padmakara

# JWT Authentication
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRY=7d

# AWS S3
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AWS_REGION=eu-west-1
AWS_S3_BUCKET=padmakara-content

# Server
PORT=3000
NODE_ENV=development

# Admin UI (optional)
VITE_API_URL=http://localhost:3000
```

## Deployment Considerations

### Production Checklist

- [ ] Use PostgreSQL with connection pooling (not SQLite)
- [ ] Set `NODE_ENV=production`
- [ ] Use strong `JWT_SECRET` (32+ random characters)
- [ ] Configure CORS for allowed origins only
- [ ] Enable HTTPS/TLS for all endpoints
- [ ] Set up error tracking (Sentry, LogRocket, etc.)
- [ ] Configure S3 bucket policies (private, not public)
- [ ] Set up database backups (automated daily)
- [ ] Configure rate limiting for API endpoints
- [ ] Use environment-specific `.env` files

### Performance Optimization

- **Database indexes**: Add indexes on foreign keys and frequently queried fields
- **Connection pooling**: Use `pg` pool for PostgreSQL connections
- **Caching**: Consider Redis for frequently accessed data (user sessions, event lists)
- **ZIP generation**: Already optimized with streaming, consider queue system for high load
- **S3 presigned URLs**: Cache URLs until near expiry to reduce S3 API calls

## Common Development Tasks

### Adding a New Endpoint

1. Define route in `src/routes/[module].ts`:
   ```typescript
   router.get("/my-endpoint", authMiddleware, async (c) => {
     const user = getUser(c);
     // Implementation
     return c.json({ data: result });
   });
   ```

2. Add validation schema (if accepting input):
   ```typescript
   const schema = z.object({ /* fields */ });
   const result = schema.safeParse(await c.req.json());
   ```

3. Write tests in `tests/routes/[module].test.ts`

4. Update this CLAUDE.md with new endpoint documentation

### Adding Database Table

1. Create schema in `src/db/schema/[module].ts`:
   ```typescript
   export const myTable = pgTable("my_table", { /* columns */ });
   export const myTableRelations = relations(myTable, ({ one, many }) => ({ /* relations */ }));
   ```

2. Export from `src/db/schema/index.ts`

3. Generate migration: `bun db:generate`

4. Apply migration: `bun db:push` (dev) or `bun db:migrate` (prod)

5. Write tests for database operations

### Troubleshooting

**Port 3000 in use:**
```bash
lsof -ti:3000 | xargs kill -9
```

**Database connection issues:**
- Check `DATABASE_URL` in `.env`
- Verify PostgreSQL is running
- Test connection: `bun db:studio`

**Test failures with Zod:**
- Ensure `deps.inline: ["zod"]` in vitest.config.ts
- Import as `import { z } from "zod"` not `"zod/v4"`

**TypeScript errors:**
- Run `bun run typecheck` to see all errors
- Check for missing type imports
- Verify Drizzle schema matches database

## Migration from Django Backend

The old Django backend (`padmakara-backend/`) is being replaced by this Hono API. Key differences:

| Feature | Django | Hono (This Project) |
|---------|--------|---------------------|
| Runtime | Python 3.12 | Bun (JavaScript/TypeScript) |
| Framework | Django 5.2.4 | Hono 4.x |
| ORM | Django ORM | Drizzle ORM |
| Auth | Django sessions | JWT tokens |
| Admin UI | Django Admin | React-admin |
| API Style | Django REST Framework | Native Hono routes |
| Testing | pytest | Vitest |

**Schema Changes:**
- `retreats` → `events`
- `gatherings` → `events` (merged)
- `retreatGroups` → `retreatGroups` (same)
- Added `downloadRequests` for ZIP tracking

## Future Enhancements

**Planned Features:**
- [ ] Device management system (login approval flow)
- [ ] PDF highlighting and annotations
- [ ] User notes and reflections
- [ ] Content recommendations based on progress
- [ ] Email notifications for new content
- [ ] Batch ZIP downloads (multiple events)
- [ ] Streaming audio (currently download-only)
- [ ] WebSocket support for real-time progress sync

**Testing Gaps to Address:**
- [ ] ZIP download feature tests (routes + service)
- [ ] S3 service integration tests
- [ ] Auth middleware edge cases
- [ ] Track parser edge cases
- [ ] Database migration validation tests

---

**Project Status**: Active development - replacing Django backend

**Maintainer**: Jeremy (frerejeremy.me)

**Last Updated**: February 2026
