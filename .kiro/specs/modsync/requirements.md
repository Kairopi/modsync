# Requirements Document

## Introduction

ModSync is a Devvit Web app that coordinates Reddit moderator activity on the modqueue in real time so two moderators do not unknowingly act on the same item at the same time. The Sept 2025 arXiv study "In the Queue: Understanding How Reddit Moderators Use the Modqueue" (n=110 moderators across 408 subreddits) reports that 74.5% of moderators have experienced collisions, where multiple mods take action on the same queue item simultaneously, producing duplicate bans, conflicting decisions, and wasted reviewer effort.

ModSync addresses this with four P0 capabilities built on Devvit Realtime, Redis, Menu Actions, and a React webview custom post:

1. Live presence and soft claims on modqueue items
2. One-click moderator action combos (composite actions like remove + lock + ban + modnote)
3. A real-time team activity feed
4. A collision metrics dashboard

ModSync also honors Reddit's onPostDelete and onCommentDelete events and scrubs deleted-account references on read to comply with Devvit Rules' user-deletion requirements.

The system is designed to install in any subreddit with two or more moderators, runs entirely on Devvit primitives (no external services for core features), and surfaces soft warnings rather than hard locks so that no moderator is ever blocked from acting.

## Glossary

- **ModSync**: The Devvit Web app described in this document.
- **Moderator (Mod)**: A Reddit user with moderator permissions in a subreddit where ModSync is installed.
- **Modqueue Item (Item)**: A post or comment surfaced for moderator review, identified by a Reddit `thingId` (e.g., `t3_abc` or `t1_xyz`).
- **Claim**: A short-lived record in Redis at key `claims:{subreddit}:{thingId}` that names the moderator currently reviewing an item and the timestamp the claim was created or refreshed.
- **TTL (Time-To-Live)**: The expiry duration on a claim record, set to 90 seconds, after which Redis removes the claim automatically.
- **Soft Warning**: A non-blocking UI notice shown to a moderator when another moderator already holds a claim on the same item. The moderator can still proceed.
- **Collision**: An event in which two or more moderators hold or attempt to act on the same item within the claim TTL window.
- **Combo**: A named sequence of moderation actions (e.g., remove post, lock thread, ban author for N days, add modnote) configured per subreddit and executable as a single menu action.
- **Activity Feed**: A capped, time-ordered log of recent moderation actions performed by the team, surfaced in the webview custom post.
- **Metrics Dashboard**: A webview tab that reports counts of collisions prevented and redundant actions avoided over a given week or month.
- **Devvit Realtime**: The Devvit-provided pub/sub channel mechanism used to propagate claims and actions to subscribed clients.
- **Custom Post**: A Devvit webview-backed post that hosts the React UI for the Activity Feed and Metrics Dashboard.

## Requirements

### Requirement 1: Install and Configure ModSync

**User Story:** As a head moderator, I want to install ModSync into my subreddit and configure combos, so that my mod team can start coordinating without writing code.

#### Acceptance Criteria

1. WHEN a moderator installs ModSync into a subreddit, THE ModSync SHALL register menu actions on posts and comments and create the ModSync custom post within that subreddit.
2. WHEN a moderator opens the ModSync app settings page, THE ModSync SHALL display a combo configuration UI restricted to users with moderator permissions on the current subreddit.
3. IF a non-moderator opens the ModSync settings page, THEN THE ModSync SHALL deny edit access and display a read-only or empty state.
4. WHEN a moderator saves a combo definition, THE ModSync SHALL persist the combo to Redis under key `combos:{subreddit}` and make the combo available within the combo picker form (surfaced by the "Run combo…" menu action) within 5 seconds.
5. THE ModSync SHALL operate in any subreddit that has two or more moderators without requiring any external service credentials.

### Requirement 2: Claim a Modqueue Item

**User Story:** As a moderator, I want to claim an item when I start reviewing it, so that my teammates know I am working on it.

#### Acceptance Criteria

1. WHEN a moderator invokes the "Claim for review" menu action on a post or comment, THE ModSync SHALL write a claim record to Redis at `claims:{subreddit}:{thingId}` containing the moderator username and the current timestamp, with a TTL of 90 seconds.
2. WHEN a claim is written, THE ModSync SHALL publish a claim event to the `claims-{subreddit}` Devvit Realtime channel containing the `thingId`, claiming username, and timestamp.
3. WHEN a moderator invokes a combo menu action on an item the moderator has not yet claimed, THE ModSync SHALL create or refresh the claim for that moderator before executing the combo.
4. IF the claim write to Redis fails, THEN THE ModSync SHALL surface an error toast to the invoking moderator and SHALL NOT publish a claim event.

### Requirement 3: See a Teammate's Claim

**User Story:** As a moderator, I want to see when a teammate has already claimed an item, so that I can avoid duplicating their work.

#### Acceptance Criteria

1. WHEN a claim event is published on `claims-{subreddit}`, THE ModSync SHALL deliver the event to all subscribed ModSync clients in that subreddit within 1 second under normal Devvit Realtime conditions.
2. WHEN a moderator invokes the "Claim for review" or any combo menu action on an item that already has an active claim held by a different moderator, THE ModSync SHALL display a soft warning identifying the claiming moderator's username and the seconds remaining on the claim.
3. WHILE a soft warning is displayed, THE ModSync SHALL allow the invoking moderator to proceed with the action without blocking.
4. WHEN a moderator proceeds with an action despite an active claim by a different moderator, THE ModSync SHALL increment the collision counter at `metrics:{subreddit}:{week}`.

### Requirement 4: Claim Expiry and Release

**User Story:** As a moderator, I want stale claims to release automatically, so that abandoned reviews do not block the team.

#### Acceptance Criteria

1. WHEN 90 seconds elapse since the most recent write or refresh of a claim, THE ModSync SHALL treat the claim as expired by relying on the Redis TTL to remove the record.
2. WHEN a moderator successfully executes a moderation action (single or combo) against an item, THE ModSync SHALL delete the claim record for that item.
3. WHEN a claim is deleted or expires, THE ModSync SHALL publish a release event to `claims-{subreddit}` so that subscribed clients clear the presence indicator.
4. IF a moderator interacts with the same item again within the TTL window, THEN THE ModSync SHALL refresh the claim timestamp and reset the TTL to 90 seconds.

### Requirement 5: Execute a One-Click Combo

**User Story:** As a moderator, I want to execute a configured combo with one click, so that I can apply consistent multi-step actions quickly.

#### Acceptance Criteria

1. WHEN a moderator invokes the "Run combo…" menu action on a post or comment and selects a combo from the resulting picker form, THE ModSync SHALL execute each configured step in the order defined by the combo.
2. THE ModSync SHALL support combo steps for at minimum: remove content, lock thread, ban author for a configurable number of days, and add a modnote with configurable text.
3. IF any combo step fails, THEN THE ModSync SHALL stop executing subsequent steps, report which step failed, and record the partial outcome in `actions:{subreddit}`.
4. WHEN a combo completes successfully, THE ModSync SHALL append a single entry to `actions:{subreddit}` summarizing the combo name, executing moderator, target `thingId`, and the steps that ran.
5. WHEN a combo execution entry is appended to `actions:{subreddit}`, THE ModSync SHALL publish the entry to the `actions-{subreddit}` Devvit Realtime channel.

### Requirement 6: Configure Combos

**User Story:** As a moderator, I want to define and edit combos for my subreddit, so that the team has shared, repeatable response templates.

#### Acceptance Criteria

1. WHEN a moderator creates a combo, THE ModSync SHALL require a unique combo name within the subreddit and at least one action step.
2. IF a moderator submits a combo with a duplicate name or zero steps, THEN THE ModSync SHALL reject the submission and display a validation message identifying the violation.
3. WHEN a moderator edits or deletes an existing combo, THE ModSync SHALL update `combos:{subreddit}` and refresh the combo list available in the "Run combo…" picker within 5 seconds.
4. THE ModSync SHALL store combo definitions exclusively in Redis under `combos:{subreddit}`.

### Requirement 7: View the Team Activity Feed

**User Story:** As a moderator, I want to see recent team moderation actions in real time, so that I have context for what my teammates are doing.

#### Acceptance Criteria

1. WHEN a moderator opens the ModSync custom post and selects the Activity Feed tab, THE ModSync SHALL display the most recent N entries from `actions:{subreddit}` in reverse chronological order, where N is at least 50.
2. WHEN a new action event is published on `actions-{subreddit}`, THE ModSync SHALL prepend the entry to the visible feed within 1 second under normal Devvit Realtime conditions.
3. THE ModSync SHALL cap `actions:{subreddit}` at 500 entries by removing the lowest-scored entries (oldest by timestamp) when the cap is exceeded; entries are stored in a Redis sorted set keyed by timestamp.
4. THE Activity Feed SHALL display, for each entry, the executing moderator's username, the combo or action name, the target `thingId` with a link, and the relative timestamp.

### Requirement 8: View the Collision Metrics Dashboard

**User Story:** As a head moderator, I want to see how many collisions ModSync prevented and how many redundant actions were avoided, so that I can demonstrate ModSync's value to the team.

#### Acceptance Criteria

1. WHEN a moderator opens the ModSync custom post and selects the Metrics tab, THE ModSync SHALL display the count of soft warnings shown, collisions detected, and redundant actions avoided for the current week and the current month, sourced from `metrics:{subreddit}:{week}` keys.
2. THE ModSync SHALL increment a "soft warning shown" counter at `metrics:{subreddit}:{week}` each time a soft warning is displayed to a moderator.
3. THE ModSync SHALL increment a "redundant action avoided" counter at `metrics:{subreddit}:{week}` each time a moderator cancels an action after seeing a soft warning.
4. WHEN no metric data exists for the selected period, THE ModSync SHALL display an empty-state message indicating zero recorded events rather than an error.

### Requirement 9: Honor Devvit Rules Deletion Events

**User Story:** As a Reddit admin reviewing ModSync for App Directory approval, I want ModSync to honor onPostDelete and onCommentDelete events and scrub deleted-account references on read as required by Devvit Rules, so that the app is compliant and approvable.

#### Acceptance Criteria

1. WHEN a PostDelete event fires for a post in a subreddit where ModSync is installed, THE ModSync SHALL remove from `actions:{subreddit}` every entry whose `thingId` equals the deleted post's id within the same event handler invocation.
2. WHEN a CommentDelete event fires for a comment in a subreddit where ModSync is installed, THE ModSync SHALL remove from `actions:{subreddit}` every entry whose `thingId` equals the deleted comment's id within the same event handler invocation.
3. WHEN ModSync reads an `actions:{subreddit}` entry whose `moderator` field references a Reddit account that responds with a deleted/suspended status from the Reddit API, THE ModSync SHALL replace the `moderator` field with the literal string `"[deleted]"` before returning the entry to any client.
4. THE ModSync SHALL NOT retain user-identifying information from a deleted post or comment beyond the entry's id and timestamp; for deleted accounts, THE ModSync SHALL scrub the moderator field from any returned entry on the next read after Reddit reports the account as deleted.

### Requirement 10: Non-Functional Requirements

**User Story:** As a judge or evaluator, I want ModSync to meet baseline performance, portability, and dependency constraints, so that the app is demo-ready and broadly installable.

#### Acceptance Criteria

1. WHEN a claim or action event is published, THE ModSync SHALL deliver the event to subscribed clients within 1 second under normal Devvit Realtime conditions.
2. THE ModSync SHALL set a TTL of 90 seconds on every claim record written to `claims:{subreddit}:{thingId}`.
3. THE ModSync SHALL function in any subreddit with two or more active moderators without subreddit-specific code changes.
4. THE ModSync SHALL implement Requirements 1 through 9 using only Devvit primitives (Devvit Web, Devvit Realtime, Redis, Menu Actions, Forms, Custom Posts, App Settings, Triggers) and SHALL NOT depend on any external service.
5. WHERE the Devvit mobile app supports menu actions on posts and comments, THE ModSync SHALL expose its "Claim for review" and combo menu actions on the mobile app.
6. THE ModSync SHALL handle duplicate trigger deliveries idempotently: re-running an `onPostDelete` or `onCommentDelete` handler with the same `thingId` SHALL produce the same final state as a single delivery.
