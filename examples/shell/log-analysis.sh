#!/bin/bash
# A tiny log-analysis pipeline over ~/data/access.log
log=~/data/access.log
echo "total requests : $(wc -l < $log)"
echo "unique clients : $(awk '{print $1}' $log | sort -u | wc -l)"

echo
echo "--- requests per status code ---"
awk '{print $8}' $log | sort | uniq -c | sort -nr

echo
echo "--- top 3 busiest clients ---"
awk '{print $1}' $log | sort | uniq -c | sort -nr | head -3

echo
echo "--- every failing request (status >= 400) ---"
awk '$8 >= 400 { print $8, $6 }' $log

echo
echo "--- write a report file ---"
{
  echo "REPORT"
  echo "errors: $(awk '$8 >= 400' $log | wc -l)"
} > ~/report.txt
cat ~/report.txt
