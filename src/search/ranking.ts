export const SEARCH_QUERY_BY = "title,province,categories,searchable_text";
export const SEARCH_QUERY_BY_WEIGHTS = "10,4,4,2";
export const SEARCH_NUM_TYPOS = "0,1,1,1";

export const FULL_SEARCH_PARAMS = {
  query_by: SEARCH_QUERY_BY,
  query_by_weights: SEARCH_QUERY_BY_WEIGHTS,
  num_typos: SEARCH_NUM_TYPOS,
  prefix: "true,false,false,false",
  typo_tokens_threshold: 1,
  drop_tokens_threshold: 0,
  sort_by: "_text_match:desc,popularity_score:desc,updated_at:desc",
} as const;

export const SUGGEST_PARAMS = {
  ...FULL_SEARCH_PARAMS,
  prefix: "true,true,true,true",
  per_page: 8,
} as const;
