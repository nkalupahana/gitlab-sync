import "dotenv/config";
import { DateTime } from "luxon";
import { simpleGit } from "simple-git"
import path from "path";

// Part 1: Get data from local repo
console.log("Checking existing history in local repo...");

const repo = simpleGit(path.join(import.meta.dirname, "repo"));
let log = {all: [], latest: null};
try {
  log = await repo.log();
} catch (e) {
  if (e.message.includes("does not have any commits yet")) {
    console.log("> No commits found in repo, continuing.");
  } else {
    throw e;
  }
}

const localDateMap = {};
for (const commit of log.all) {
  const date = DateTime.fromISO(commit.date).toISODate();
  if (!localDateMap[date]) {
    localDateMap[date] = 0;
  }
  localDateMap[date]++;
}

// Part 2: Pull missing data from GitLab
console.log("Pulling history from GitLab...");
let gitlabData = [];
let page = 1;
while (true) {
  let url = `${process.env.GITLAB_API_URL}/users/${process.env.GITLAB_USER_ID}/events?page=${page}&per_page=100&sort=asc`;
  // If the repo is not empty, only fetch events from ~after this script was last run
  if (log.latest) {
    const date = DateTime.fromISO(log.latest.date).minus({days: 7}).toISODate();
    url += `&after=${date}`;
  }
  const response = await fetch(url, {
    headers: {
      'PRIVATE-TOKEN': process.env.GITLAB_PAT
    }
  });

  const events = await response.json();
  if (events.length === 0) {
    break;
  }

  gitlabData.push(...events);
  console.log(`> Fetched page ${page}`);
  ++page;
}

// Only push events with one commit (i.e. not rebases -- not perfect but good enough)
gitlabData = gitlabData.filter(event => event.action_name === "pushed to" && event.push_data.commit_count === 1);
const gitlabDateMap = {};
for (const event of gitlabData) {
  const date = DateTime.fromISO(event.created_at).toISODate();
  if (!gitlabDateMap[date]) {
    gitlabDateMap[date] = 0;
  }
  gitlabDateMap[date]++;
}

// Part 3: Create commits for missing data
console.log("Creating missing commits...");
for (const date in gitlabDateMap) {
  if (!localDateMap[date] || localDateMap[date] < gitlabDateMap[date]) {
    const count = gitlabDateMap[date] - (localDateMap[date] || 0);
    if (count < 0) {
      console.warn("WARN: Local commit count is higher than GitLab count for date", date);
    }
    console.log(`> Creating ${count} commit${count !== 1 ? "s" : ""} for ${date}`);
    for (let i = 0; i < count; ++i) {
      await repo.commit(`Commit for ${date}`, [], { "--date": date, "--allow-empty": true });
    }
  }
}

// Part 4: Rebase and push!
console.log("Rebasing commit dates... (this may take a while, run git status in the repo to see progress)");
await repo.rebase({ ...(log.latest ? { [`${log.latest.hash}^`]: true } : { "--root": true }), "--committer-date-is-author-date": true, "--force": true})
console.log("Pushing...")
await repo.push("origin", "main", {"--force": true});