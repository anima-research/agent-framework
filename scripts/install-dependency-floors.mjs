import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { npmCommand } from "./single-threaded.mjs";

const npm = npmCommand();
const run = (args, capture) => {
  const done = spawnSync(npm.file, [...npm.args, ...args], { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (done.error) throw done.error;
  if (done.status !== 0) {
    console.error(`npm ${args.join(" ")} exited ${done.status ?? done.signal}`);
    process.exit(1);
  }
  return done.stdout;
};

const lower = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

const floorOf = (name, range) => {
  const answer = run(["view", `${name}@${range}`, "version", "--json"], true).trim();
  const versions = [JSON.parse(answer)].flat();
  const prerelease = versions.find((version) => version.includes("-"));
  if (prerelease) {
    console.error(`${name} ${range} admits a prerelease, ${prerelease}, which this job doesn't order: give a range of releases`);
    process.exit(1);
  }
  return versions.reduce((low, version) => (lower(version, low) ? version : low));
};

const declared = () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const ranges = new Map();
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"])
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (ranges.has(name) && ranges.get(name) !== range) {
        console.error(`${name} is declared as ${ranges.get(name)} and as ${range}: give it one range`);
        process.exit(1);
      }
      ranges.set(name, range);
    }
  return ranges;
};

const mode = process.argv[2];
if (mode === "plan") {
  const ranges = declared();
  const lowest = new Map([...ranges].map(([name, range]) => [name, floorOf(name, range)]));
  const install = (name, floor) => Object.fromEntries([...lowest].map(([n, f]) => [n, n === name ? floor : f]));
  const legs = [{ name: "lowest", install: install() }];
  for (const [name, range] of ranges) {
    const members = range.split("||").map((member) => member.trim()).filter(Boolean);
    if (members.length < 2) continue;
    for (const member of members) {
      const floor = floorOf(name, member);
      if (floor !== lowest.get(name) && !legs.some((leg) => leg.name === `${name} ${floor}`))
        legs.push({ name: `${name} ${floor}`, install: install(name, floor) });
    }
  }
  console.log(`legs=${JSON.stringify(legs)}`);
} else if (mode === "install") {
  const leg = JSON.parse(process.env.LEG || "null");
  const floors = Object.entries(leg?.install ?? {});
  const names = [...declared().keys()];
  const missing = names.filter((name) => !floors.some(([given]) => given === name));
  const extra = floors.map(([given]) => given).filter((given) => !names.includes(given));
  if (!floors.length || missing.length || extra.length) {
    const why = floors.length
      ? [missing.length && `leaves out ${missing.join(", ")}`, extra.length && `names ${extra.join(", ")}, which package.json doesn't declare`].filter(Boolean)
      : ["gives none"];
    console.error(`LEG must give a floor for each dependency package.json declares, as plan prints it: it ${why.join(" and ")}`);
    process.exit(1);
  }
  console.log(`Floors (${leg.name}): ${floors.map(([name, floor]) => `${name} ${floor}`).join(", ")}`);
  run(["install", "--no-save", ...floors.map(([name, floor]) => `${name}@${floor}`)]);
  const off = floors.flatMap(([name, floor]) => {
    const installed = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
    return installed === floor ? [] : [`${name} ${installed}, not ${floor}`];
  });
  if (off.length) {
    console.error(`Not at its floor: ${off.join("; ")}`);
    process.exit(1);
  }
} else {
  console.error("usage: node scripts/install-dependency-floors.mjs plan|install");
  process.exit(2);
}
