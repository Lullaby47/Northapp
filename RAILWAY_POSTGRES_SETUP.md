# PostgreSQL Support for Railway Deployment

## Overview

NorthApp now supports both **SQLite** (local development) and **PostgreSQL** (Railway production) with automatic detection based on environment variables.

## How It Works

### Database Selection
- **PostgreSQL**: Used when `DATABASE_URL` environment variable is set
- **SQLite**: Used when `DATABASE_URL` is not set (local development)

### Startup Logs
The app will log which database it's using:

**PostgreSQL:**
```
[DB] backend=postgres url set: true
[DB] PostgreSQL schema initialized
```

**SQLite:**
```
[DB] backend=sqlite path=./app.db
```

## Railway Setup

### 1. Add PostgreSQL Plugin
1. Go to your Railway project
2. Click "New" → "Database" → "Add PostgreSQL"
3. Railway will automatically set the `DATABASE_URL` environment variable

### 2. Deploy
Push your code to GitHub and Railway will automatically:
- Detect PostgreSQL via `DATABASE_URL`
- Create all tables and indexes on first startup
- Use persistent PostgreSQL storage (no more data loss on redeploys!)

## Local Development

### SQLite (Default)
No configuration needed! Just run:
```bash
npm install
npm start
```

Database file: `./app.db`

### Test with Local PostgreSQL (Optional)
If you want to test PostgreSQL locally:

1. Install PostgreSQL locally
2. Create a database:
   ```sql
   CREATE DATABASE northapp_dev;
   ```
3. Set environment variable:
   ```bash
   # Windows PowerShell
   $env:DATABASE_URL="postgresql://username:password@localhost:5432/northapp_dev"
   
   # Linux/Mac
   export DATABASE_URL="postgresql://username:password@localhost:5432/northapp_dev"
   ```
4. Run:
   ```bash
   npm start
   ```

## Schema Management

### Automatic Initialization
Both SQLite and PostgreSQL schemas are automatically created on startup if tables don't exist.

### Schema Differences
The database wrapper handles differences automatically:

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Auto-increment | `AUTOINCREMENT` | `SERIAL` |
| Timestamps | `datetime('now')` | `CURRENT_TIMESTAMP` |
| Foreign Keys | Enabled via PRAGMA | Native support |
| Transactions | Synchronous | Asynchronous |

## Database Wrapper API

The database wrapper provides a consistent async API for both backends:

```javascript
// All operations return Promises
const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
const users = await db.prepare("SELECT * FROM users").all();
await db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(balance, userId);
await db.exec("CREATE TABLE ...");

// Transactions
await db.transaction(async () => {
  await db.prepare("UPDATE ...").run(...);
  await db.prepare("INSERT ...").run(...);
})();
```

## Troubleshooting

### "relation does not exist" Error
This means the schema wasn't initialized. Check:
1. Logs show: `[DB] PostgreSQL schema initialized`
2. If not, check for errors in startup logs
3. Verify `DATABASE_URL` is correct

### "password authentication failed"
1. Check Railway PostgreSQL credentials
2. Verify `DATABASE_URL` format:
   ```
   postgresql://user:password@host:port/database
   ```

### Schema Mismatch After Update
If you add new tables/columns:
1. PostgreSQL: Schema updates happen automatically
2. SQLite: Delete `app.db` to recreate (local only!)

## Files Changed

### New Files
- `db.js` - Database abstraction layer (updated)

### Modified Files
- `server.js` - All routes now use async/await for database operations
- `package.json` - Added `pg` dependency

### Dependencies Added
```json
{
  "pg": "^8.x.x"
}
```

## Environment Variables

### Production (Railway)
```bash
# Automatically set by Railway PostgreSQL plugin
DATABASE_URL=postgresql://user:pass@host:port/db?sslmode=require
```

### Local Development
```bash
# Optional - for testing PostgreSQL locally
DATABASE_URL=postgresql://localhost:5432/northapp_dev

# Optional - for custom SQLite path
DB_PATH=./data/app.db
```

## Migration from SQLite to PostgreSQL

If you have existing SQLite data you want to migrate:

1. **Export SQLite data:**
   ```bash
   sqlite3 app.db .dump > data.sql
   ```

2. **Convert to PostgreSQL format:**
   - Remove SQLite-specific syntax
   - Convert `AUTOINCREMENT` to `SERIAL`
   - Convert `datetime('now')` to `CURRENT_TIMESTAMP`

3. **Import to PostgreSQL:**
   ```bash
   psql $DATABASE_URL < data_converted.sql
   ```

**Note:** This is manual. Consider doing a fresh start on Railway instead.

## Performance Notes

### SQLite
- Fast for single-server deployments
- All operations synchronous (wrapped in Promises)
- Perfect for local development

### PostgreSQL
- Better for production/cloud deployments
- All operations natively async
- Survives server restarts/redeploys
- Better concurrency handling

## Security

### SSL Connections
PostgreSQL connections use SSL by default when deployed (Railway provides SSL).

For localhost connections (development), SSL is disabled automatically.

### Connection Pooling
PostgreSQL uses connection pooling via `pg.Pool`:
- Default: 10 connections max
- Connections are reused efficiently
- Automatic connection management

## Testing

### Before Deployment
1. Test locally with SQLite:
   ```bash
   npm start
   ```
   
2. Register a user, create games, test all features

3. (Optional) Test with local PostgreSQL:
   ```bash
   DATABASE_URL="postgresql://localhost:5432/test" npm start
   ```

### After Railway Deployment
1. Check logs for `[DB] backend=postgres url set: true`
2. Test registration (first user becomes admin)
3. Test all features
4. Redeploy and verify data persists

## Support

If you encounter issues:
1. Check Railway logs
2. Verify `DATABASE_URL` is set correctly
3. Ensure PostgreSQL plugin is added to your Railway project
4. Check this documentation for troubleshooting steps

---

**Your data will now persist across Railway redeploys!** 🎉
