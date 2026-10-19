- Releases from the 0.22 line publish under the npm dist-tag `release-0.22`
  instead of `latest`, which stays on the newest line, 0.23. The registry
  won't move `latest` back from 0.23.0 implicitly, so without the tag a
  0.22 release's publish fails after its tag is pushed, as 0.21.2's did. A
  semver range such as `^0.22.2` resolves to the newest 0.22 release
  without naming the tag. On GitHub, a 0.22 release isn't marked Latest.
