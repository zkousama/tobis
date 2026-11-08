-- Ride times riders chose to share (functions/api/times.js). Nothing about who sent them.
CREATE TABLE IF NOT EXISTS times (
  id INTEGER PRIMARY KEY,
  k TEXT NOT NULL,        -- "hop" (stop a to stop b) or "wait" (at stop a)
  line TEXT NOT NULL,
  dir TEXT NOT NULL,      -- the direction's id in the app's data
  a TEXT NOT NULL,
  b TEXT,
  s INTEGER NOT NULL,     -- seconds
  day TEXT NOT NULL,      -- YYYY-MM-DD
  hour INTEGER NOT NULL,
  wday INTEGER NOT NULL,  -- 0 = Sunday
  received TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS times_day ON times (day);
