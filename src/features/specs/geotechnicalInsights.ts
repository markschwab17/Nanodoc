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
  highImpact: ["Affects compaction effort and schedule.", "Drives water/additive and equipment choice."],
  insights: ["Compare to optimal moisture to plan conditioning.", "Document in proposal to justify means and methods."],
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
      highImpact: ["Directly drives whether you need to add water or dry soils; affects production and cost."],
      insights: ["Wet of optimum: consider aeration or lime; dry of optimum: water trucks and timing.", "Include moisture conditioning in your means and methods."],
    },
    "Site Development": {
      highImpact: ["Determines site prep and compaction strategy across the project."],
      insights: ["Plan for dewatering or moisture conditioning by phase.", "Affects duration and equipment (tillers, water trucks)."],
    },
    "Underground Utilities": {
      highImpact: ["Backfill compaction and pipe bedding depend on moisture content."],
      insights: ["Specify moisture at placement for trench backfill and bedding.", "Avoid swell/shrink under pavements and structures."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade moisture affects subbase stability and pavement performance."],
      insights: ["Control moisture before subbase and paving to avoid pumping or settlement.", "Document for warranty and claims."],
    },
    "Demolition": {
      highImpact: ["Influences handling and disposal of excavated material."],
      insights: ["Wet soils increase haul weight and may require drying or special disposal.", "Plan for dewatering if reusing on-site."],
    },
    "Land Development": {
      highImpact: ["Drives grading and compaction strategy for lots and infrastructure."],
      insights: ["Balance cut/fill moisture to minimize import/export and conditioning.", "Phase work around seasonal moisture."],
    },
    "Highway Construction": {
      highImpact: ["Critical for subgrade and embankment compaction to meet density specs."],
      insights: ["Often strict OMC tolerance; plan moisture conditioning in the bid.", "Affects roller type and pass count."],
    },
    "Commercial Site work": {
      highImpact: ["Impacts building pad and pavement subgrade quality."],
      insights: ["Coordinate with structural and paving; document for QA and warranty.", "Schedule conditioning to avoid delays."],
    },
    "Residential Development": {
      highImpact: ["Affects lot grading, compaction, and foundation support."],
      insights: ["Vary by lot; include moisture conditioning in unit pricing.", "Wet soils can delay lot release."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsOptimalMoisture(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Target range for compaction; outside range increases cost and risk of rejection."],
      insights: ["Bid water trucks or drying (lime/aeration) to bring soils into range.", "Include OMC in field QC narrative."],
    },
    "Site Development": {
      highImpact: ["Defines acceptable moisture window for each lift and area."],
      insights: ["Plan sequencing so work happens when soils are near OMC.", "Document OMC in submittals."],
    },
    "Underground Utilities": {
      highImpact: ["Backfill and bedding must be placed at or near OMC for density."],
      insights: ["Specify OMC in backfill procedures; plan for conditioning in trenches.", "Avoid future settlement under pavement."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade should be near OMC before subbase and paving."],
      insights: ["Prevent pumping and loss of support; include in subgrade prep spec.", "Tie to density and proof-roll."],
    },
    "Demolition": {
      highImpact: ["Less direct; relevant if reusing or selling excavated material."],
      insights: ["If reusing, OMC helps plan placement and compaction.", "Otherwise note for disposal handling."],
    },
    "Land Development": {
      highImpact: ["Target for all compacted fill and subgrade."],
      insights: ["Use OMC range in cut/fill balance and conditioning estimates.", "Phase work to hit OMC where possible."],
    },
    "Highway Construction": {
      highImpact: ["Typically strict; outside range can mean failed density and rework."],
      insights: ["Include conditioning in unit price; plan for weather and moisture management.", "Document OMC in QC reports."],
    },
    "Commercial Site work": {
      highImpact: ["Required for pads and pavement subgrade acceptance."],
      insights: ["Align with spec section on compaction and moisture; include in QA plan.", "Track versus existing moisture."],
    },
    "Residential Development": {
      highImpact: ["Target for lot fill and subgrade under slabs and pavement."],
      insights: ["Vary by soil type and lot; include in lot grading and compaction scope.", "Communicate OMC to subs."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsExpansionIndex(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["High EI soils can swell and damage overlying work; may require removal or treatment."],
      insights: ["Price removal or lime stabilization if EI exceeds spec.", "Avoid using high-EI material under pavements or structures."],
    },
    "Site Development": {
      highImpact: ["Drives where expansive soils can remain and where they must be removed or treated."],
      insights: ["Map EI to phases; include removal/stabilization in earthwork bid.", "Protect utilities and pavements from swell."],
    },
    "Underground Utilities": {
      highImpact: ["Swell can load pipes and structures; backfill choice is critical."],
      insights: ["Use low-EI backfill where required; avoid expansive native in critical zones.", "Document EI in trench sections."],
    },
    "Paving & Concrete": {
      highImpact: ["Expansion under pavement causes heave and failure; often strict EI limits."],
      insights: ["Remove or treat high-EI subgrade per spec; include in subgrade prep.", "Tie to warranty and long-term performance."],
    },
    "Demolition": {
      highImpact: ["Identifies material that may be unsuitable for reuse or require special handling."],
      insights: ["High-EI export may have different disposal or reuse constraints.", "Note for site restoration."],
    },
    "Land Development": {
      highImpact: ["Determines fill and subgrade design (removal, treatment, or acceptance)."],
      insights: ["Balance cut/fill with EI; avoid placing high-EI under structures or pavement.", "Include in grading and compaction narrative."],
    },
    "Highway Construction": {
      highImpact: ["Subgrade and embankment often have EI limits; excess triggers removal or stabilization."],
      insights: ["Bid removal or lime/fly ash stabilization; document EI in QC.", "Affects subgrade acceptance."],
    },
    "Commercial Site work": {
      highImpact: ["Building pads and pavement subgrade typically have EI caps."],
      insights: ["Include removal or stabilization in earthwork; tie to structural and paving specs.", "Track EI by area for QA."],
    },
    "Residential Development": {
      highImpact: ["High EI under slabs and pavement causes callbacks and warranty issues."],
      insights: ["Remove or treat under foundations and pavement; include in lot scope.", "Communicate EI to foundation and paving subs."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsShrinkage(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Shrinkage reduces volume; affects quantity takeoffs and haul/import."],
      insights: ["Apply shrinkage factor to cut/fill and import; document in quantity letter.", "Affects balance and cost."],
    },
    "Site Development": {
      highImpact: ["Impacts earthwork quantities and balance across the site."],
      insights: ["Include shrinkage in mass diagram and quantity estimates.", "Varies by soil type and moisture."],
    },
    "Underground Utilities": {
      highImpact: ["Trench backfill may shrink and cause settlement if not compacted properly."],
      insights: ["Account for shrinkage in backfill quantities; compact at OMC to minimize.", "Avoid settlement over pipes."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade shrinkage can cause settlement and pavement failure."],
      insights: ["Control moisture and compaction to limit shrinkage; note in subgrade prep.", "Relevant for long-term performance."],
    },
    "Demolition": {
      highImpact: ["Volume change affects disposal and reuse quantities."],
      insights: ["Apply shrinkage when estimating export or reuse volumes.", "Document for billing and disposal."],
    },
    "Land Development": {
      highImpact: ["Drives cut/fill and import/export quantities."],
      insights: ["Use shrinkage factor in takeoffs and balance; include in earthwork narrative.", "Varies by soil and moisture."],
    },
    "Highway Construction": {
      highImpact: ["Embankment and subgrade quantities depend on shrinkage factor."],
      insights: ["Apply agency shrinkage factor to quantities; document in quantity report.", "Affects pay quantities."],
    },
    "Commercial Site work": {
      highImpact: ["Affects fill and balance quantities for pads and site work."],
      insights: ["Include shrinkage in earthwork takeoffs and submittals.", "Tie to spec and QA."],
    },
    "Residential Development": {
      highImpact: ["Lot grading and fill quantities depend on shrinkage."],
      insights: ["Apply shrinkage in lot balance and import; communicate to grading sub.", "Affects unit cost."],
    },
  };
  return byScope[scope] ?? DEFAULT_INSIGHTS;
}

function scopeInsightsSubsidence(scope: ScopeKey): CharacteristicInsights {
  const byScope: Record<ScopeKey, CharacteristicInsights> = {
    "Earthwork Grading Contractor": {
      highImpact: ["Settlement after placement affects finish grade and overlying work."],
      insights: ["Include overbuild or preload where subsidence is expected.", "Document for schedule and QC."],
    },
    "Site Development": {
      highImpact: ["Settlement can damage utilities, pavement, and structures if not accounted for."],
      insights: ["Plan for preload, overbuild, or staged construction where subsidence is high.", "Include in phasing and schedule."],
    },
    "Underground Utilities": {
      highImpact: ["Differential settlement can damage pipes and structures."],
      insights: ["Design backfill and bedding to limit settlement; consider overexcavation and select fill.", "Document for warranty."],
    },
    "Paving & Concrete": {
      highImpact: ["Subgrade settlement causes pavement failure and warranty claims."],
      insights: ["Address in subgrade prep (overexcavation, stabilization, preload).", "Tie to spec and long-term performance."],
    },
    "Demolition": {
      highImpact: ["Less direct; relevant if fill is placed for restoration."],
      insights: ["If placing fill, account for subsidence in thickness and finish grade.", "Note for post-demolition grading."],
    },
    "Land Development": {
      highImpact: ["Settlement affects finish grades and building pads."],
      insights: ["Include overbuild or preload in earthwork; phase to allow settlement where possible.", "Document in grading plan."],
    },
    "Highway Construction": {
      highImpact: ["Embankment and subgrade settlement affect profile and rideability."],
      insights: ["Apply settlement factor in design and construction; preload or stage if needed.", "Document for acceptance."],
    },
    "Commercial Site work": {
      highImpact: ["Building and pavement performance depend on limiting settlement."],
      insights: ["Include in subgrade and fill design; preload or overbuild per spec.", "Track for QA and warranty."],
    },
    "Residential Development": {
      highImpact: ["Settlement under slabs and pavement causes callbacks."],
      insights: ["Address in pad and lot grading; overbuild or allow time for settlement.", "Communicate to foundation and paving subs."],
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
