-- dialect: postgres
-- Real PostgreSQL (compiled to WebAssembly) running in your browser. Nothing is stored anywhere.
CREATE TEMP TABLE planets (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  moons       int,
  discovered  date
);

INSERT INTO planets (name, moons, discovered) VALUES
  ('Mars',    2,  NULL),
  ('Jupiter', 95, NULL),
  ('Uranus',  28, '1781-03-13'),
  ('Neptune', 16, '1846-09-23');

SELECT * FROM planets ORDER BY id;

-- Postgres-only goodies: RETURNING, FILTER, string_agg, generate_series
UPDATE planets SET moons = moons + 1 WHERE name = 'Mars' RETURNING id, name, moons;

SELECT count(*) FILTER (WHERE discovered IS NOT NULL) AS with_date,
       string_agg(name, ', ' ORDER BY name)           AS names,
       version()                                       AS server
FROM planets;

SELECT n, n * n AS square FROM generate_series(1, 5) AS n;
