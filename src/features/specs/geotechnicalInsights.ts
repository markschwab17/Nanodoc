/**
 * Static scope-based insights for key soil characteristics.
 * Used in the geotechnical results panel to show how each characteristic
 * impacts the selected project scope (High impact + Insights bullets).
 */

import type { GeotechnicalSoilCharacteristicKey, GeotechnicalScope } from "@/core/ai/types";

export interface CharacteristicInsights {
  highImpact: string[];
  insights: string[];
}

type ScopeKey = GeotechnicalScope;

const SCOPES: ScopeKey[] = [
  "Earthwork Grading Contractor",
  "Site Development",
  "Underground Utilities",
  "Paving & Concrete",
  "Demolition",
  "Land Development",
  "Highway Construction",
  "Commercial Site work",
  "Residential Development",
];

const CHARACTERISTICS: GeotechnicalSoilCharacteristicKey[] = [
  "existing_moisture",
  "optimal_moisture",
  "expansion_index",
  "shrinkage",
  "subsidence",
];

/** Default insights when no scope-specific content is defined (fallback). */
const DEFAULT_INSIGHTS: CharacteristicInsights = {
  highImpact: ["Drives your moisture conditioning cost and equipment (water trucks, tillers, lime)."],
  insights: ["Bid conditioning to bring soil into spec range; document in means & methods.", "Compare to optimal moisture—outside range risks failed density and rework."],
};

/**
 * Build the full (characteristic × scope) map with contractor-focused bullets.
 * Each cell is { highImpact: string[], insights: string[] }.
 */
function buildInsightsMap(): Map<string, CharacteristicInsights> {
  const map = new Map<string, CharacteristicInsights>();

  const key = (char: GeotechnicalSoilCharacteristicKey, scope: ScopeKey) => `${char}|${scope}`;

  for (const scope of SCOPES) {
    for (const char of CHARACTERISTICS) {
      const k = key(char, scope);
      const content = getInsightsForPair(char, scope);
      map.set(k, content);
    }
  }

  return map;
}

function getInsightsForPair(char: GeotechnicalSoilCharacteristicKey, scope: ScopeKey): CharacteristicInsights {
  switch (char) {
    case "existing_moisture":
      return scopeInsightsExistingMoisture(scope);
    case "optimal_moisture":
      return scopeInsightsOptimalMoisture(scope);
    case "expansion_index":
      return scopeInsightsExpansionIndex(scope);
    case "shrinkage":
      return scopeInsightsShrinkage(scope);
    case "subsidence":
      return scopeInsightsSubsidence(scope);
    default:
      return DEFAULT_INSIGHTS;
  }
}

function scopeInsightsExistingMoisture(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Bid driver: wet soils need drying (lime/aeration); dry soils need water—directly affects your cost and production."],
      insights: ["Include moisture conditioning in your unit price and means & methods.", "Wet of optimum: price tillage, lime, or aeration; dry: price water trucks and application."],
    },
    "Site Development": {
      highImpact: ["Drives site prep cost and schedule: conditioning by phase affects equipment and duration."],
      insights: ["Bid dewatering or moisture conditioning per phase; plan tillers/water trucks.", "Document in schedule—wet soils can push compaction and delay downstream work."],
    },
    "Underground Utilities": {
      highImpact: ["Backfill and bedding must be at acceptable moisture for density—affects placement and acceptance."],
      insights: ["Specify moisture at placement in backfill procedures; bid conditioning in trench if needed.", "Avoid placing wet backfill under pavement or structures (swell/settlement risk)."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade moisture drives pumping and settlement risk—directly tied to warranty and callbacks."],
      insights: ["Bid subgrade prep and moisture control before subbase; document for QA.", "Wet subgrade = pumping and loss of support; control before proof-roll and paving."],
    },
    "Demolition": {
      highImpact: ["Wet soils = heavier haul, possible special disposal or drying—affects haul and disposal cost."],
      insights: ["Price haul and disposal based on moisture; wet loads weigh more and may need different handling.", "If reusing on-site, plan dewatering or drying and include in scope."],
    },
    "Land Development": {
      highImpact: ["Cut/fill moisture drives import/export and conditioning cost across lots and infrastructure."],
      insights: ["Balance moisture in cut/fill to minimize import and conditioning; phase work when soils are workable.", "Include conditioning in grading bid; document by phase for schedule."],
    },
    "Highway Construction": {
      highImpact: ["Density acceptance is strict; wrong moisture = failed test and rework—must be in bid."],
      insights: ["Bid moisture conditioning (water trucks, tillage) to stay within OMC tolerance.", "Affects roller selection and pass count; document in QC and quantity letter."],
    },
    "Commercial Site work": {
      highImpact: ["Pad and pavement subgrade acceptance depend on moisture—delays and rework if not controlled."],
      insights: ["Coordinate with structural and paving; bid conditioning and document in QA plan.", "Schedule subgrade prep so moisture is right before foundations and pavement."],
    },
    "Residential Development": {
      highImpact: ["Lot-by-lot moisture drives conditioning cost and can delay lot release and foundations."],
      insights: ["Include moisture conditioning in lot unit price; wet soils often delay compaction release.", "Communicate to foundation and paving subs—moisture affects their schedule."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsOptimalMoisture(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Your compaction target—outside this range = failed density, rework, and cost you eat."],
      insights: ["Bid water trucks or drying (lime/aeration) to get into range; put in means & methods.", "Include OMC in QC narrative and submittals so you can prove compliance."],
    },
    "Site Development": {
      highImpact: ["Acceptable moisture window for each lift—drives when you can compact and what you bid."],
      insights: ["Sequence work so compaction happens when soils are near OMC; bid conditioning where they won’t be.", "Document OMC in submittals and tie to density logs."],
    },
    "Underground Utilities": {
      highImpact: ["Backfill and bedding must be at or near OMC for density—otherwise settlement and callbacks."],
      insights: ["Write OMC into backfill procedures; bid conditioning in trench if soils are wet/dry.", "Avoid placing out-of-range backfill under pavement—future settlement is your problem."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade must be near OMC before subbase and paving or you get pumping and failure."],
      insights: ["Include moisture control in subgrade prep bid; tie to proof-roll and density.", "Document that subgrade was at OMC—protects you on warranty and claims."],
    },
    "Demolition": {
      highImpact: ["Matters if you’re reusing or selling material—placement and compaction need to hit OMC."],
      insights: ["If reusing, plan placement and compaction at OMC; include in scope and price.", "If exporting only, note OMC for disposal handling and weight."],
    },
    "Land Development": {
      highImpact: ["Target for all compacted fill and subgrade—drives conditioning cost and phasing."],
      insights: ["Use OMC range in cut/fill and conditioning takeoffs; phase work to hit OMC where you can.", "Document in grading narrative; out of range = rework and delay."],
    },
    "Highway Construction": {
      highImpact: ["Agency specs are strict; outside OMC = failed density, rework, no pay until fixed."],
      insights: ["Bid conditioning in unit price; plan for weather and moisture management in schedule.", "Document OMC in every QC report—required for acceptance."],
    },
    "Commercial Site work": {
      highImpact: ["Pad and pavement subgrade acceptance require moisture at OMC—schedule and QA depend on it."],
      insights: ["Align bid and QA plan with spec compaction/moisture section; track existing vs OMC.", "Schedule subgrade prep so moisture is right before structural and paving."],
    },
    "Residential Development": {
      highImpact: ["Target for lot fill and subgrade under slabs and pavement—varies by soil and lot."],
      insights: ["Include OMC in lot grading and compaction scope and unit price.", "Communicate OMC to foundation and paving subs so they can plan."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsExpansionIndex(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["High EI = swell under pavement/structure—you’ll remove or stabilize; must be in the bid."],
      insights: ["Price removal or lime stabilization where EI exceeds spec; don’t bury high-EI under pavements.", "Call out EI in means & methods and tie to spec limits."],
    },
    "Site Development": {
      highImpact: ["Drives where you remove or treat vs leave in place—directly affects earthwork cost and phasing."],
      insights: ["Map EI by phase; bid removal/stabilization and protect utilities and pavement from swell.", "Include in earthwork narrative; high-EI in wrong place = callbacks."],
    },
    "Underground Utilities": {
      highImpact: ["Swell loads pipes and structures—backfill type and placement drive your cost and risk."],
      insights: ["Use specified low-EI backfill in critical zones; avoid expansive native next to pipe.", "Document EI in trench sections and backfill submittals."],
    },
    "Paving & Concrete": {
      highImpact: ["EI limits under pavement are strict—heave = failure and warranty; subgrade prep must address it."],
      insights: ["Bid removal or treatment of high-EI subgrade per spec; include in subgrade prep line.", "Document for warranty; uncontrolled EI = callbacks."],
    },
    "Demolition": {
      highImpact: ["High-EI export may have different disposal or reuse rules—affects haul and disposal cost."],
      insights: ["Check disposal/reuse requirements for high-EI material; price accordingly.", "Note for site restoration if placing fill."],
    },
    "Land Development": {
      highImpact: ["Decides removal vs treatment vs leave in place—drives grading and balance cost."],
      insights: ["Don’t place high-EI under structures or pavement; include removal/stabilization in bid.", "Document EI in grading narrative and compaction submittals."],
    },
    "Highway Construction": {
      highImpact: ["EI over limit = no acceptance until removed or stabilized—must be in unit price."],
      insights: ["Bid removal or lime/fly ash stabilization where EI exceeds spec; document in QC.", "Tie to subgrade acceptance and pay."],
    },
    "Commercial Site work": {
      highImpact: ["Pad and pavement subgrade have EI caps—over = rework and warranty exposure."],
      insights: ["Include removal or stabilization in earthwork bid; align with structural and paving specs.", "Track EI by area in QA; document for acceptance."],
    },
    "Residential Development": {
      highImpact: ["High EI under slabs and pavement = callbacks and warranty—fix before foundations and paving."],
      insights: ["Remove or treat under foundations and pavement; include in lot scope and price.", "Communicate EI to foundation and paving subs so they can plan."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsShrinkage(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Shrinkage reduces placed volume—your takeoffs and import need the right factor or you’re short."],
      insights: ["Apply spec or typical shrinkage factor to cut/fill and import; put in quantity letter.", "Wrong factor = not enough fill, extra import, or disputed quantities."],
    },
    "Site Development": {
      highImpact: ["Drives earthwork quantities and balance—wrong shrinkage = wrong import/export and cost."],
      insights: ["Include shrinkage in mass diagram and quantity estimates; document factor used.", "Varies by soil and moisture; tie to spec or geotech recommendation."],
    },
    "Underground Utilities": {
      highImpact: ["Backfill shrinks after placement—under-order and you’re short; poor compaction = more settlement."],
      insights: ["Order backfill with shrinkage in mind; compact at OMC to minimize settlement.", "Settlement over pipe = callbacks; document placement and compaction."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade shrinkage = settlement and pavement failure—control moisture and compaction."],
      insights: ["Address in subgrade prep (moisture, compaction); note in submittals.", "Document for long-term performance and warranty."],
    },
    "Demolition": {
      highImpact: ["Volume change affects export and reuse quantities—billing and disposal."],
      insights: ["Apply shrinkage when estimating export or reuse volumes; document for billing.", "Wet vs dry weight and volume affect haul and disposal cost."],
    },
    "Land Development": {
      highImpact: ["Cut/fill and import/export quantities depend on shrinkage—directly affects bid and balance."],
      insights: ["Use shrinkage factor in takeoffs and balance; state in earthwork narrative.", "Wrong factor = balance and cost issues; document source of factor."],
    },
    "Highway Construction": {
      highImpact: ["Pay quantities and balance use agency shrinkage factor—wrong factor = quantity disputes."],
      insights: ["Apply agency shrinkage factor to all quantity takeoffs; document in quantity report.", "Affects pay quantities and balance; keep consistent with spec."],
    },
    "Commercial Site work": {
      highImpact: ["Fill and balance for pads and site work depend on shrinkage—affects quantities and cost."],
      insights: ["Include shrinkage in earthwork takeoffs and submittals; tie to spec.", "Document factor for QA and quantity reconciliation."],
    },
    "Residential Development": {
      highImpact: ["Lot balance and import depend on shrinkage—wrong factor = short fill or extra cost."],
      insights: ["Apply shrinkage in lot balance and import; include in grading sub scope.", "Communicate factor to grading sub; affects unit cost and quantities."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsSubsidence(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Settlement after placement eats your finish grade—overbuild or preload must be in the bid."],
      insights: ["Bid overbuild or preload where subsidence is expected; document in means & methods.", "Schedule and QC: allow time or lift thickness so finish grade is met after settlement."],
    },
    "Site Development": {
      highImpact: ["Unplanned settlement damages utilities, pavement, and structures—you own the fix if you didn’t plan for it."],
      insights: ["Bid preload, overbuild, or staged construction where subsidence is high; put in phasing.", "Include in schedule—settlement time can drive critical path."],
    },
    "Underground Utilities": {
      highImpact: ["Differential settlement breaks pipes and structures—backfill and bedding must limit it."],
      insights: ["Use specified backfill and bedding to limit settlement; consider overexcavation and select fill.", "Document placement and compaction for warranty; settlement = callbacks."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade settlement = pavement failure and warranty—address in subgrade prep or eat the callback."],
      insights: ["Bid overexcavation, stabilization, or preload per spec in subgrade prep.", "Document for long-term performance and warranty; tie to spec."],
    },
    "Demolition": {
      highImpact: ["Matters when you place fill for restoration—thickness and finish grade must allow for settlement."],
      insights: ["If placing fill, add subsidence to thickness and finish grade; include in scope.", "Document for post-demolition grading and acceptance."],
    },
    "Land Development": {
      highImpact: ["Settlement drives finish grades and pad elevations—overbuild or preload must be in earthwork bid."],
      insights: ["Include overbuild or preload in earthwork; phase to allow settlement where possible.", "Document in grading plan and submittals; wrong grade = rework."],
    },
    "Highway Construction": {
      highImpact: ["Settlement affects profile and rideability—agency will reject if not addressed."],
      insights: ["Apply settlement factor per spec; bid preload or staging if required.", "Document in construction and QC for acceptance and pay."],
    },
    "Commercial Site work": {
      highImpact: ["Pad and pavement performance depend on limiting settlement—spec usually requires preload or overbuild."],
      insights: ["Bid subgrade and fill per spec (preload, overbuild); track in QA.", "Document for warranty; settlement = structural and pavement callbacks."],
    },
    "Residential Development": {
      highImpact: ["Settlement under slabs and pavement = callbacks—fix in pad and lot grading scope."],
      insights: ["Bid overbuild or allow time for settlement in pad and lot grading.", "Communicate to foundation and paving subs so they don’t build on fresh fill."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

const insightsMap = buildInsightsMap();

function mapKey(characteristicKey: GeotechnicalSoilCharacteristicKey, scope: GeotechnicalScope): string {
  return `${characteristicKey}|${scope}`;
}

/** Display label for each characteristic (table "Characteristic" column). */
export const CHARACTERISTIC_LABELS: Record<GeotechnicalSoilCharacteristicKey, string> = {
  existing_moisture: "Existing moisture",
  optimal_moisture: "Optimal moisture",
  expansion_index: "Expansion index",
  shrinkage: "Shrinkage",
  subsidence: "Subsidence",
};

/**
 * Returns scope-based insights for a given characteristic and scope.
 * Used in the geotechnical results panel under each expandable row.
 */
export function getInsights(
  characteristicKey: GeotechnicalSoilCharacteristicKey,
  scope: GeotechnicalScope
): CharacteristicInsights {
  return insightsMap.get(mapKey(characteristicKey, scope)) ?? DEFAULT_INSIGHTS;
}
