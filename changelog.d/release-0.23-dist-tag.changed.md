- Releases from the 0.23 line publish under the npm dist-tag `release-0.23`
  instead of `latest`, which stays on the newest line, 0.24. The registry
  won't move `latest` back from 0.24.0 implicitly, so without the tag a
  0.23 release's publish fails after its tag is pushed. A semver range such
  as `^0.23.1` resolves to the newest 0.23 release without naming the tag.
  On GitHub, a 0.23 release isn't marked Latest.
