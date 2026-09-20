#!/bin/sh
{
  i=1
  while [ $i -le 30 ]; do
    case $((i % 3)) in
      0) echo "finding $i: hard-coded database password in config/db.yml";;
      1) echo "finding $i: unused import in src/util.js";;
      2) echo "finding $i: missing null check may crash on empty response";;
    esac
    i=$((i + 1))
  done
} > findings.txt
