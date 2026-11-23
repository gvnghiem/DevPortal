#!/bin/bash
# Variables, loops, functions, arrays and arithmetic.
name="DevPortal"
count=3
echo "Welcome to $name — counting to $count:"
for i in $(seq 1 $count); do
  echo "  step $i"
done

# a function with an argument and a return value via echo
square() { echo $(( $1 * $1 )); }
echo "7 squared = $(square 7)"

# an array
fruits=(apple banana cherry)
echo "I have ${#fruits[@]} fruits:"
for f in "${fruits[@]}"; do
  echo " - $f (${#f} letters)"
done

# conditions
n=17
if [ $n -gt 10 ] && [ $((n % 2)) -eq 1 ]; then
  echo "$n is big and odd"
else
  echo "$n is something else"
fi

# case statement
for day in sat mon; do
  case $day in
    sat|sun) echo "$day: weekend" ;;
    *)       echo "$day: workday" ;;
  esac
done

# while loop with arithmetic
total=0; k=1
while [ $k -le 5 ]; do total=$((total + k)); k=$((k + 1)); done
echo "sum 1..5 = $total"
