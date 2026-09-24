/** The insight metrics Conveyor reads, one account-level query at ad level. */
export const INSIGHT_FIELDS = ['ad_id', 'ad_name', 'adset_id', 'campaign_id', 'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'actions', 'purchase_roas', 'date_start', 'date_stop'] as const;
/** Action types read from `actions`. */
export const PURCHASE_ACTION_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'] as const;
export const INSIGHTS_DATE_PRESET = 'maximum';
