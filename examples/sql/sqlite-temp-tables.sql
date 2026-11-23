-- dialect: sqlite
-- Temp tables live only for this session, so they are perfect for practice: nothing to clean up.
CREATE TEMP TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
CREATE TEMP TABLE orders    (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, placed DATE);

INSERT INTO customers VALUES (1,'Ada','London'), (2,'Linus','Helsinki'), (3,'Grace','New York'), (4,'Alan','London');
INSERT INTO orders VALUES
  (1, 1, 120.50, '2024-01-05'), (2, 1,  80.00, '2024-02-11'), (3, 2, 45.25, '2024-02-14'),
  (4, 3, 300.00, '2024-03-02'), (5, 1,  19.99, '2024-03-09');

-- INNER JOIN: customers who ordered
SELECT c.name, COUNT(o.id) AS orders, ROUND(SUM(o.amount), 2) AS spent
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.id ORDER BY spent DESC;

-- LEFT JOIN: everyone, including customers with no orders
SELECT c.name, IFNULL(SUM(o.amount), 0) AS spent
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id ORDER BY c.name;

-- Materialise a result into a second temp table, then query that
CREATE TEMP TABLE big_spenders AS
  SELECT customer_id, SUM(amount) AS spent FROM orders GROUP BY customer_id HAVING SUM(amount) > 100;
SELECT c.name, b.spent FROM big_spenders b JOIN customers c ON c.id = b.customer_id;
