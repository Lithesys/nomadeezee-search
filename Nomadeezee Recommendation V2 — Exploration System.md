# Nomadeezee Recommendation V2

## Goal

Cải thiện recommendation feed để:

- Place chưa từng được user thấy vẫn có cơ hội xuất hiện.
- Không để popular places thống trị toàn bộ feed.
- Không random các địa điểm kém liên quan chỉ để exploration.
- Hạn chế lặp lại place user vừa xem.
- Thu thập đủ telemetry để có thể nâng cấp sang Thompson Sampling sau này.
- Giữ implementation đơn giản và phù hợp với Supabase/Postgres.

---

# 1. Architecture

Implement feed theo pipeline:

```text
User Request
    ↓
Build User Context
    ↓
Candidate Generation
    ├── Personalized candidates
    ├── Content-based candidates
    ├── Nearby candidates
    ├── Trending candidates
    └── Unseen exploration candidates
    ↓
Base Scoring
    ↓
Epsilon-Greedy Mixer
    ↓
Diversity Re-ranking
    ↓
Seen / repetition penalty
    ↓
Final Feed
    ↓
Impression Tracking
```

Không query rồi random trực tiếp từ toàn bộ `places`.

---

# 2. Exploration policy

Default configuration:

```ts
const RECOMMENDATION_CONFIG = {
  explorationRate: 0.15,

  candidatePoolSize: 200,

  exploitationPoolSize: 100,
  explorationPoolSize: 100,

  feedSize: 20,

  maxSameCategoryConsecutive: 2,

  recentSeenHardBlockHours: 6,

  seenPenaltyDays: 30,
};
```

Ý nghĩa:

```text
85% exploitation
15% exploration
```

Với feed 20 places:

```text
17 exploitation
3 exploration
```

Không cần chính xác tuyệt đối từng request.

Có thể tính:

```ts
const explorationCount = Math.max(
  1,
  Math.round(feedSize * explorationRate),
);

const exploitationCount =
  feedSize - explorationCount;
```

---

# 3. Definition của exploration candidate

Exploration candidate KHÔNG phải random place.

Candidate phải:

```text
accessible to user
AND active
AND not deleted
AND not recently shown
AND relevant enough
AND quality above minimum threshold
```

Ưu tiên:

```text
never seen
>
seen long ago
>
recently seen
```

Exploration pool cần lấy từ:

```text
unseen + relevant
```

không phải:

```text
unseen + random
```

---

# 4. Required tables

## 4.1 place_impressions

Create table:

```sql
create table public.place_impressions (
  id uuid primary key default gen_random_uuid(),

  user_id uuid references auth.users(id) on delete cascade,

  place_id uuid not null
    references public.places(id) on delete cascade,

  session_id uuid,

  request_id uuid,

  position integer not null,

  source text not null,

  recommendation_score double precision,

  exploration boolean not null default false,

  created_at timestamptz not null default now()
);
```

Allowed `source` values:

```text
collaborative
content
nearby
trending
exploration
search
similar
```

Indexes:

```sql
create index place_impressions_user_place_idx
on public.place_impressions(user_id, place_id);

create index place_impressions_user_created_idx
on public.place_impressions(user_id, created_at desc);

create index place_impressions_place_created_idx
on public.place_impressions(place_id, created_at desc);
```

---

# 5. Aggregated recommendation statistics

Do not repeatedly aggregate entire impression table during every feed request.

Create:

```sql
create table public.place_recommendation_stats (
  place_id uuid primary key
    references public.places(id) on delete cascade,

  impressions bigint not null default 0,

  detail_views bigint not null default 0,

  likes bigint not null default 0,

  saves bigint not null default 0,

  shares bigint not null default 0,

  hides bigint not null default 0,

  weighted_reward double precision not null default 0,

  updated_at timestamptz not null default now()
);
```

Update asynchronously or through existing interaction pipeline.

Do not block feed generation on updating these counters.

---

# 6. User-place state

Create lightweight aggregation table:

```sql
create table public.user_place_recommendation_state (
  user_id uuid not null
    references auth.users(id) on delete cascade,

  place_id uuid not null
    references public.places(id) on delete cascade,

  impression_count integer not null default 0,

  detail_view_count integer not null default 0,

  like_count integer not null default 0,

  save_count integer not null default 0,

  hide_count integer not null default 0,

  last_impression_at timestamptz,

  last_interaction_at timestamptz,

  primary key (user_id, place_id)
);
```

Indexes:

```sql
create index user_place_rec_last_seen_idx
on public.user_place_recommendation_state(
  user_id,
  last_impression_at desc
);
```

This table should be used for feed ranking instead of scanning raw impressions.

---

# 7. Candidate generation

Create independent candidate sources.

Do not attempt to calculate one giant score over every place.

Target:

```text
~200 total candidates/request
```

---

## 7.1 Personalized candidates

Use existing recommendation system.

Return approximately:

```text
100 candidates
```

Example:

```ts
type RecommendationCandidate = {
  placeId: string;

  personalizationScore: number;
  contentScore: number;
  distanceScore: number;
  qualityScore: number;
  popularityScore: number;
  freshnessScore: number;

  impressionCount: number;
  lastImpressionAt: string | null;

  source:
    | "collaborative"
    | "content"
    | "nearby"
    | "trending"
    | "exploration";

  isUnseen: boolean;
};
```

---

## 7.2 Exploration candidates

Select places where:

```sql
state.place_id is null
OR state.impression_count = 0
```

Then rank them before sampling.

Do not randomize before ranking.

Suggested exploration score:

```text
exploration_score =
    0.30 * content_similarity
  + 0.25 * geographic_relevance
  + 0.20 * quality_score
  + 0.15 * freshness_score
  + 0.10 * popularity_prior
```

Important:

`popularity_prior` must have low weight.

Otherwise exploration simply becomes another popularity ranking.

---

# 8. Geographic relevance

If current location exists:

Use PostGIS.

Example:

```sql
ST_DWithin(
  places.location,
  user_location,
  radius_meters
)
```

Do not enforce 1 km globally.

Use adaptive radius.

Suggested initial values:

```text
dense city:
1–3 km

normal urban:
5 km

sparse regions:
10–30 km
```

Candidate generation should expand radius only if insufficient results exist.

Example:

```text
3 km
↓ insufficient candidates
5 km
↓ insufficient
10 km
↓
20 km
```

Stop when candidate target reached.

---

# 9. Base scoring

Normalize all components to:

```text
0 → 1
```

Recommended base score:

```ts
baseScore =
  0.35 * personalizationScore +
  0.20 * contentScore +
  0.15 * distanceScore +
  0.15 * qualityScore +
  0.10 * freshnessScore +
  0.05 * popularityScore;
```

Do not make popularity greater than approximately 10%.

Otherwise feedback loop will return.

---

# 10. Quality score

Quality should prevent poor newly-created items from entering exploration simply because they are unseen.

Example:

```text
quality_score =
    image_quality
  + metadata_completeness
  + community_signals
  + creator_trust
```

Possible initial implementation:

```ts
qualityScore =
  0.30 * hasGoodImage +
  0.25 * metadataCompleteness +
  0.20 * normalizedSaveRate +
  0.15 * normalizedLikeRate +
  0.10 * creatorQuality;
```

If those signals do not exist yet, start simpler:

```ts
qualityScore =
  0.4 * hasImage +
  0.3 * metadataCompleteness +
  0.3 * interactionQuality;
```

---

# 11. Seen penalty

Do not permanently remove previously seen places.

Use two stages.

## Hard block

If seen within:

```text
6 hours
```

exclude from recommendation unless candidate pool becomes too small.

---

## Soft decay

Example:

```ts
function seenMultiplier(
  lastSeenAt: Date | null,
): number {
  if (!lastSeenAt) return 1;

  const days =
    (Date.now() - lastSeenAt.getTime()) /
    86_400_000;

  if (days < 0.25) return 0;
  if (days < 1) return 0.15;
  if (days < 3) return 0.35;
  if (days < 7) return 0.6;
  if (days < 14) return 0.8;
  if (days < 30) return 0.95;

  return 1;
}
```

Then:

```ts
finalBaseScore =
  baseScore *
  seenMultiplier(lastImpressionAt);
```

---

# 12. Epsilon-Greedy feed mixer

Do not implement epsilon-greedy as:

```ts
Math.random() < epsilon
  ? randomPlace()
  : bestPlace();
```

Implement at feed level.

```ts
function buildFeed(
  exploitationCandidates,
  explorationCandidates,
  feedSize = 20,
  epsilon = 0.15,
) {
  const explorationCount = Math.max(
    1,
    Math.round(feedSize * epsilon),
  );

  const exploitationCount =
    feedSize - explorationCount;

  const exploitation = selectTopDiversified(
    exploitationCandidates,
    exploitationCount,
  );

  const exploration = weightedSample(
    explorationCandidates,
    explorationCount,
    candidate => candidate.explorationScore,
  );

  return interleave(
    exploitation,
    exploration,
  );
}
```

---

# 13. Weighted exploration

Do not always pick the top exploration candidate.

Otherwise exploration itself becomes deterministic.

Use weighted random sampling.

Example:

```ts
weight =
  Math.exp(explorationScore / temperature);
```

Suggested:

```text
temperature = 0.15–0.30
```

Higher temperature:

```text
more diversity
```

Lower temperature:

```text
more greedy
```

Start:

```ts
temperature = 0.2;
```

This gives unseen candidates different chances while preserving relevance.

---

# 14. Exploration placement

Do not put all exploration items at the bottom.

For 20 items, approximate placement:

```text
1 exploitation
2 exploitation
3 exploration

4 exploitation
5 exploitation
6 exploitation
7 exploitation

8 exploration

...

14 exploration
```

Add jitter.

Avoid:

```text
positions 18, 19, 20 always exploration
```

because lower feed positions naturally receive fewer impressions and will bias evaluation.

---

# 15. Diversity reranking

After mixing, apply constraints.

Examples:

```text
max 2 consecutive same category
max 2 same collection/topic
avoid highly similar coordinates consecutively
avoid same creator consecutively
```

Pseudo:

```ts
rerankForDiversity(
  mixedCandidates,
  {
    maxSameCategoryConsecutive: 2,
    maxSameCreatorConsecutive: 1,
  }
);
```

Never destroy recommendation quality just for diversity.

Treat these as soft constraints.

---

# 16. Impression definition

An item should not count as seen merely because API returned it.

Count impression only when frontend actually displays it.

Recommended rule:

```text
>= 50% visible
for >= 500 ms
```

Frontend:

```text
IntersectionObserver
```

Then batch send:

```http
POST /api/recommendations/impressions
```

Example:

```json
{
  "requestId": "...",
  "impressions": [
    {
      "placeId": "...",
      "position": 3,
      "source": "exploration"
    }
  ]
}
```

Batch impression calls.

Do not fire one API request per card.

---

# 17. Interaction telemetry

Track at least:

```text
impression
detail_open
long_detail_view
like
save
share
hide
```

Optional later:

```text
map_open
directions_open
collection_add
comment
```

---

# 18. Reward model

Do not optimize only CTR.

Initial event weights:

```ts
const EVENT_REWARD = {
  impression: 0,

  detail_open: 1,
  long_detail_view: 2,

  like: 3,
  save: 4,
  share: 4,

  hide: -5,
};
```

This weighted reward is mainly for analytics now.

Do not yet use it as a complex online-learning model.

Store it because it will become the reward signal for Thompson Sampling later.

---

# 19. Cold-start user

For users with no history:

Use:

```text
location
+
trending nearby
+
content quality
+
freshness
+
exploration
```

Suggested weights:

```text
location       35%
quality        25%
trending       20%
freshness      20%
```

Do not pretend personalization exists.

---

# 20. Anonymous users

For unauthenticated users:

Use a temporary:

```text
device/session recommendation history
```

Client can send:

```text
session_id
```

Avoid repeating items within the current session.

Do not require DB persistence per anonymous user unless existing architecture supports it cleanly.

---

# 21. API

Preferred endpoint:

```http
GET /api/recommendations/feed
```

Parameters:

```text
limit
cursor
lat
lng
session_id
```

Example response:

```json
{
  "requestId": "uuid",
  "items": [
    {
      "place": {},
      "recommendation": {
        "source": "exploration",
        "score": 0.72,
        "isExploration": true
      }
    }
  ],
  "nextCursor": "..."
}
```

Do not expose full internal scoring details publicly.

---

# 22. Pagination

Avoid classic:

```text
OFFSET 20
OFFSET 40
```

because recommendation ordering can change.

Use request/session-aware pagination.

At minimum maintain IDs already returned:

```text
excluded_place_ids
```

Better:

Create recommendation session state:

```text
recommendation_session
```

containing already served items.

If architecture overhead is undesirable, keep the first implementation stateless and pass a compact cursor.

---

# 23. Database RPC

Candidate fetching should preferably happen in Postgres.

Suggested RPC:

```text
get_recommendation_candidates(
  user_id,
  lat,
  lng,
  limit
)
```

And separate:

```text
get_exploration_candidates(
  user_id,
  lat,
  lng,
  limit
)
```

Do not put business-level feed mixing logic deeply inside SQL.

Use:

```text
Postgres:
filter + retrieve candidate pool

Application:
score + epsilon mixing + diversity
```

This keeps tuning easier.

---

# 24. Performance

Target database work:

```text
retrieve 100–300 candidates
```

not:

```text
score every 10,000 places in Node.js
```

Use DB indexes:

```text
location GiST index
category indexes
visibility/accessibility indexes
created_at
user interaction indexes
```

If pgvector is used:

```text
HNSW
```

or appropriate ANN index.

---

# 25. Exploration eligibility

Define minimum exploration requirements.

Example:

```ts
function isExplorationEligible(place) {
  return (
    place.isActive &&
    place.hasImage &&
    place.metadataCompleteness >= 0.5 &&
    !place.isBlocked &&
    !place.isRecentlySeen
  );
}
```

Do not let incomplete junk places receive guaranteed exposure.

---

# 26. Feature flags

All recommendation changes must be configurable.

Example:

```ts
RECOMMENDATION_EXPLORATION_ENABLED=true
RECOMMENDATION_EXPLORATION_RATE=0.15
RECOMMENDATION_EXPLORATION_TEMPERATURE=0.20
RECOMMENDATION_RECENT_SEEN_HOURS=6
```

Do not hardcode tuning values throughout the codebase.

Centralize them.

---

# 27. Logging

For every recommendation request log:

```text
request_id
user_id / session_id
candidate_count
exploration_candidate_count
final_feed_size
exploration_count
latency
```

Do not log sensitive user profile content.

---

# 28. Metrics

Create dashboard metrics:

```text
overall CTR

exploration CTR

exploration meaningful engagement rate

save rate

detail view rate

hide rate

unique places exposed/day

% feed items unseen before

coverage =
unique places shown /
eligible places

repeat rate

average recommendation latency
```

The most important metric for this feature:

```text
catalog coverage
```

Before exploration:

```text
small subset of places receives most impressions
```

After exploration:

```text
more eligible places receive exposure
```

without materially degrading meaningful engagement.

---

# 29. A/B test

Eventually compare:

```text
Control:
epsilon = 0

Treatment:
epsilon = 0.15
```

Evaluate:

```text
save rate
meaningful detail views
hide rate
catalog coverage
unique discovered places/user
```

Do not decide success based only on CTR.

---

# 30. Guardrails

Ensure:

```text
hidden/private/inaccessible places never leak
blocked creators excluded
deleted places excluded
user-hidden places excluded
user-blocked places excluded
```

Existing RLS/accessibility logic must remain authoritative.

Recommendation system must never bypass access rules.

---

# 31. Migration path to Thompson Sampling

Design code now so exploration strategy is swappable.

Interface:

```ts
interface ExplorationStrategy {
  select(
    candidates: RecommendationCandidate[],
    count: number,
    context: RecommendationContext,
  ): RecommendationCandidate[];
}
```

Current implementation:

```ts
class EpsilonWeightedExploration
  implements ExplorationStrategy {}
```

Future:

```ts
class ThompsonSamplingExploration
  implements ExplorationStrategy {}
```

Do not couple feed pipeline directly to epsilon-specific code.

---

# 32. Future Thompson Sampling data

Start collecting:

```text
impressions
positive rewards
negative rewards
context
source
position
```

Later add:

```text
alpha
beta
```

or segmented priors based on:

```text
category
geo region
user interest cluster
```

Do not implement Thompson Sampling yet.

---

# 33. Recommended code structure

```text
src/
  recommendation/
    config.ts

    types.ts

    candidate-generation/
      personalized.ts
      exploration.ts
      nearby.ts
      trending.ts

    scoring/
      base-score.ts
      quality-score.ts
      distance-score.ts
      freshness-score.ts
      seen-penalty.ts

    exploration/
      strategy.ts
      epsilon-weighted.ts

    reranking/
      diversity.ts
      deduplicate.ts

    feed/
      build-feed.ts

    telemetry/
      impressions.ts
      interactions.ts
```

Avoid giant recommendation service files.

---

# 34. Implementation order

Implement in this exact order.

## Phase 1

Add:

```text
place_impressions
user_place_recommendation_state
place_recommendation_stats
```

Add RLS and indexes.

---

## Phase 2

Instrument frontend:

```text
actual impressions
detail view
like
save
hide
```

Verify telemetry accuracy before changing ranking.

---

## Phase 3

Implement:

```text
candidate generation
seen filtering
base scoring
```

Keep current recommendation as exploitation source where possible.

---

## Phase 4

Implement:

```text
15% weighted exploration
```

Only select:

```text
unseen + relevant + quality-qualified
```

---

## Phase 5

Implement:

```text
diversity reranker
interleaving
pagination protections
```

---

## Phase 6

Add monitoring and feature flags.

Launch initially with:

```text
epsilon = 0.10
```

then increase toward:

```text
0.15
```

if engagement remains healthy.

---

# 35. Acceptance criteria

Implementation is complete when:

1. A place with `0 impressions` can appear in feed.

2. Unseen places are not random; they are geographically/content relevant.

3. Recently seen places are strongly suppressed.

4. Old impressions decay rather than permanently excluding a place.

5. Approximately 10–15% of feed can originate from exploration.

6. Exploration cards are distributed throughout feed positions.

7. Frontend records impressions only when actually visible.

8. Exploration and exploitation performance can be measured separately.

9. Recommendation respects all existing accessibility and RLS rules.

10. Exploration strategy can later be swapped for Thompson Sampling without rewriting the feed pipeline.

---

# Final architecture

```text
                   USER CONTEXT
                       │
                       ▼
              Candidate Generation
          ┌────────────┼─────────────┐
          │            │             │
   Personalized     Nearby       Unseen
          │            │             │
          └────────────┼─────────────┘
                       ▼
                  Base Scoring
                       │
                       ▼
              Seen / quality filter
                       │
                ┌──────┴──────┐
                │             │
          Exploitation    Exploration
               85%            15%
                │             │
                └──────┬──────┘
                       ▼
                 Feed Mixing
                       │
                       ▼
               Diversity Rerank
                       │
                       ▼
                   20 Places
                       │
                       ▼
              Impression Tracking
                       │
                       ▼
            Recommendation Signals
```

The main principle is:

```text
Exploration ≠ random.

Exploration =
less-exposed
+
relevant
+
quality-qualified
+
controlled randomness.
```