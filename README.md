# dudamel-plugin
A context multiplier plug-in for Claude CLI

## Features

* Local sqlite database~ auto-create
* Save records for each project
  * by repo name (for Git)
  * by path (for non-Git)
* Each record gets a vector embedding
* Prior to a think
  * retrieve relevant records from db via semantic search
* After each think
  * If it's a fix upsert associated `issue`record(s)
  * if it's an improvement upsert associated `specification` record(s)
* Tools for Claude
  * search ~ semantic vector search
  * CRUD project
  * CRUD issue ~ per project
  * CRID specification ~ per project
  * 
