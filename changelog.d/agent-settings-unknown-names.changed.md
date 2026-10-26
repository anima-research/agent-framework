- `agent_settings` refuses an update that names something that isn't a setting
  (`Unknown setting: tail_token`), or names `settings`, which only a reset
  reads, where it dropped the name unseen and answered as if the call had
  succeeded. A reset refuses a name beside `settings` the same way, where it
  dropped the name and reset everything.
