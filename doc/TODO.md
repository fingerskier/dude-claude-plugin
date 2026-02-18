* Add `files` field to records
  * agents will update this field to be a list of the most pertinent files involved in the work described by the record (if any)
  * use relative file-paths (i.e. project root)
 
* Add a `claimed_at` timestamp and `claimed_by`
  * when an agent _takes on_ a task it calls the MCP Tool: `claim_task`
    * Dude sets `claimed_at` and generates an ID in `claimed_by` and returns that ID
  * when completed the agent calls MCP Tool `release_task`
    * Dude clears `claimed_at` and `claimed_by`
  * if an agent hangs or dies the timestamp remains but subsequent agents could see aging tasks and, at some point, assume they are no longer being worked on because of the age
  * if an agent tries to claim a previously claimed record Dude can:
    * allow if `claimed_by` and `updated` are older than 30min (or whatever the staleness time is)
    * otherwise return a warning, in the form of the `previous_claim` (which the agent can honor or not)~ may prompt the user
  
