#!/bin/bash
# The Unix superpower: small tools connected with pipes.
cd ~/data
echo "== people.csv =="
cat people.csv

echo
echo "== names only (cut) =="
cut -d, -f1 people.csv | tail -n +2

echo
echo "== sorted by age, oldest first (sort) =="
tail -n +2 people.csv | sort -t, -k3 -nr | head -3

echo
echo "== average age (awk) =="
tail -n +2 people.csv | awk -F, '{ s += $3; n++ } END { printf "%d people, average age %.1f\n", n, s/n }'

echo
echo "== most common words (tr | sort | uniq -c) =="
cat words.txt | tr 'A-Z' 'a-z' | tr -s ' ' '\n' | sort | uniq -c | sort -nr | head -5

echo
echo "== search + replace (grep, sed) =="
grep -E " (404|500) " access.log
echo "hello world" | sed 's/world/shell/'
