-- dialect: sqlite
-- A real SQLite database running in your browser. Every run starts empty, so scripts are repeatable.
CREATE TEMP TABLE planets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  moons INTEGER,
  diameter_km INTEGER
);

INSERT INTO planets (name, moons, diameter_km) VALUES
  ('Mercury', 0, 4879),
  ('Venus',   0, 12104),
  ('Earth',   1, 12756),
  ('Mars',    2, 6792),
  ('Jupiter', 95, 142984),
  ('Saturn',  146, 120536);

-- the whole table
SELECT * FROM planets;

-- filter, compute, sort
SELECT name, moons, ROUND(diameter_km / 12756.0, 2) AS earths_wide
FROM planets
WHERE moons > 0
ORDER BY diameter_km DESC;

-- aggregate
SELECT COUNT(*) AS planets, SUM(moons) AS total_moons, MAX(diameter_km) AS widest FROM planets;
