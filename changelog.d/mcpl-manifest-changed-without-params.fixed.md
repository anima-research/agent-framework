- An `mcpl/manifestChanged` notification sent without params is handled like
  any other: the fetched manifest is applied, its
  `mcpl:manifest-change-receipt` is emitted naming no domains, and the tools
  list is refreshed. Previously the handler threw once it had applied the
  manifest, so the receipt and the refresh were skipped. The receipt's
  `announcedDomains` now holds only the strings of the announcement's
  `domains` array.
