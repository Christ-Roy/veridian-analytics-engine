import {
  IsString,
  IsArray,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  Min,
  Max,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DateRangeDto,
  DateRangeValidator,
  FilterDto,
} from './analytics-query.dto';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';

/**
 * Une étape de funnel = un `goal_name` (ou n'importe quel event `name`).
 * On garde volontairement simple : chaque étape = un nom d'objectif. L'ordre du
 * tableau `steps` définit la séquence du tunnel.
 */
export class FunnelStepDto {
  @IsString()
  goal_name: string;

  /** Libellé affiché (optionnel) ; défaut = goal_name. */
  @IsOptional()
  @IsString()
  label?: string;
}

/**
 * DTO du funnel (tunnel de vente). Calcule, pour une séquence ordonnée d'étapes
 * (objectifs), combien de sessions/visiteurs atteignent chaque étape + les taux
 * de passage N→N+1 et global. Filtrable par canal (channel/channel_group) via
 * `filters`. Borné : 2..8 étapes.
 */
export class FunnelQueryDto {
  @IsString()
  workspace_id: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => FunnelStepDto)
  steps: FunnelStepDto[];

  @Validate(DateRangeValidator)
  @ValidateNested()
  @Type(() => DateRangeDto)
  dateRange: DateRangeDto;

  /**
   * Filtres dimensionnels (réutilise le contrat analytics) — typiquement
   * `{ dimension: 'channel_group', operator: 'equals', values: ['ads'] }`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  filters?: FilterDto[];

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  /**
   * Unité de progression dans le tunnel :
   *  - 'session' (défaut) : un même session_id doit franchir les étapes ;
   *  - 'visitor'          : un même visitor_id (cross-session) franchit les étapes.
   */
  @IsOptional()
  @IsString()
  unit?: 'session' | 'visitor';

  /**
   * Fenêtre windowFunnel en secondes. Défaut = la plage de dates entière (les
   * étapes peuvent s'étaler sur toute la période). Bornée à 1..7776000 (90j).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7_776_000)
  window_seconds?: number;

  /**
   * Segmentation A/B/C : nom d'une dimension (`DIMENSIONS`) sur la table `goals`.
   * Quand fourni, le funnel est calculé EN UNE SEULE requête ClickHouse, une
   * série de niveaux par valeur distincte de la dimension (ex : `segment_by:
   * 'variant'` → un entonnoir par variante A/B/C côte à côte). La réponse passe
   * alors de la forme mono-série plate (`FunnelResponse`) à `FunnelSegmentedResponse`
   * (`{ segment_by, segments[] }`). Sans `segment_by`, le contrat mono-série est
   * strictement inchangé. Garde-fou : un segment_by qui produit plus de
   * `SEGMENT_MAX` (12) séries lève 400 SEGMENT_CARDINALITY_EXCEEDED (protège
   * ClickHouse contre une dimension à haute cardinalité).
   */
  @IsOptional()
  @IsString()
  segment_by?: string;
}

/**
 * Limite dure du nombre de séries qu'un `segment_by` peut produire. Au-delà, on
 * refuse (400) au lieu de tronquer en silence : une dimension à haute
 * cardinalité (ex : `city`, `page_path`) exploserait la réponse et la charge
 * ClickHouse. 12 couvre largement un A/B/C/D… réaliste.
 */
export const SEGMENT_MAX = 12;

export interface FunnelStepResult {
  step: number;
  goal_name: string;
  label: string;
  /** Sessions/visiteurs ayant atteint CETTE étape (et donc toutes les précédentes). */
  count: number;
  /**
   * Valeur € cumulée des goals de CETTE étape pour les unités l'ayant atteinte
   * (A3-value) — `sumIf(goal_value, level >= N)`. 0 si les goals ne portent pas
   * de `goal_value`. La donnée est lue depuis la table `goals`.
   */
  value: number;
  /** Taux de passage depuis l'étape précédente (%) ; null pour l'étape 1. */
  conversion_from_previous: number | null;
  /** Taux global depuis l'étape 1 (%). */
  conversion_from_start: number;
  /** Abandons entre l'étape précédente et celle-ci. */
  dropoff_from_previous: number;
}

export interface FunnelResponse {
  workspace_id: string;
  unit: 'session' | 'visitor';
  dateRange: { start: string; end: string };
  /** Total d'unités entrées dans le tunnel (= count de l'étape 1). */
  entered: number;
  /** Taux de conversion bout-en-bout (étape 1 → dernière étape) en %. */
  overall_conversion: number;
  steps: FunnelStepResult[];
}

/**
 * Une série (un mini-funnel complet) pour une valeur de la dimension de
 * segmentation. Même forme interne que `FunnelResponse` moins l'enveloppe
 * workspace/unit/dateRange (factorisée au niveau de `FunnelSegmentedResponse`).
 */
export interface FunnelSegment {
  /** Valeur brute de la dimension de segmentation (ex : 'A', 'desktop'). */
  key: string;
  /** Libellé affiché ; = key pour l'instant (le front mappe si besoin). */
  label: string;
  /** Unités entrées dans CE segment (= count de l'étape 1 du segment). */
  entered: number;
  /** Conversion bout-en-bout de CE segment (%). */
  overall_conversion: number;
  steps: FunnelStepResult[];
}

/**
 * Réponse multi-séries (renvoyée UNIQUEMENT quand `segment_by` est fourni). Le
 * cas mono-série continue de renvoyer `FunnelResponse` (forme plate inchangée).
 * Le consommateur discrimine sur la présence de `segment_by`/`segments`.
 */
export interface FunnelSegmentedResponse {
  workspace_id: string;
  unit: 'session' | 'visitor';
  dateRange: { start: string; end: string };
  /** Nom de la dimension de segmentation demandée (discriminant). */
  segment_by: string;
  /** Une série par valeur distincte de la dimension, triée par `entered` desc. */
  segments: FunnelSegment[];
}

/** Union retournée par `AnalyticsService.funnel` selon la présence de segment_by. */
export type FunnelResult = FunnelResponse | FunnelSegmentedResponse;
