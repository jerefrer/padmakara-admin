/**
 * Migration Decision Configuration Reader
 *
 * Reads and validates migration-decisions.yaml configuration file.
 * Provides type-safe access to migration decisions.
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

export interface MigrationConfig {
  storage: {
    strategy: "in_place" | "new_bucket";
    target_bucket?: string;
    folder_pattern: string;
    delete_zips_after_extraction: boolean;
  };
  tracks: {
    legacy_strategy: "legacy_folder" | "merge_main" | "separate_audio1";
    mismatch_strategy: "trust_files" | "trust_csv" | "manual_review";
  };
  content: {
    no_audio_strategy: "skip" | "create_placeholder" | "manual_review";
    auto_discover_transcripts: boolean;
    create_transcript_metadata_only: boolean;
  };
  mapping: {
    unmapped_strategy: "skip_event" | "create_null" | "infer";
    infer_teachers: boolean;
    infer_places: boolean;
  };
  validation: {
    min_success_rate: number;
    fail_fast: boolean;
    generate_html_report: boolean;
    preflight_checks: string[];
  };
  execution: {
    batch_size: number;
    batch_delay_ms: number;
    s3_concurrency: number;
    save_state: boolean;
    state_file: string;
    state_save_interval: number;
  };
  rollback: {
    on_failure: "keep_partial" | "rollback_all" | "manual";
    cleanup_original_bucket: boolean;
    archive_to_glacier: boolean;
    keep_migration_logs: boolean;
    retention_days: number;
  };
  notifications: {
    enable_progress_logs: boolean;
    log_level: "debug" | "info" | "warn" | "error";
    notify_on_completion: boolean;
    notify_on_errors: boolean;
    email?: {
      enabled: boolean;
      recipients: string[];
      smtp_host: string;
      smtp_port: number;
    };
  };
  metadata: {
    decided_by: string;
    decision_date: string;
    approved_by: string;
    notes: string;
  };
}

/**
 * Load and parse migration configuration from YAML file
 */
export function loadConfig(configPath: string): MigrationConfig {
  try {
    const yamlContent = readFileSync(configPath, "utf-8");
    const config = parseYaml(yamlContent) as MigrationConfig;

    // Validate required fields
    validateConfig(config);

    return config;
  } catch (error: any) {
    throw new Error(`Failed to load configuration from ${configPath}: ${error.message}`);
  }
}

/**
 * Validate configuration structure and values
 */
function validateConfig(config: MigrationConfig): void {
  const errors: string[] = [];

  // Storage validation
  if (!config.storage) {
    errors.push("Missing 'storage' section");
  } else {
    if (!["in_place", "new_bucket"].includes(config.storage.strategy)) {
      errors.push("storage.strategy must be 'in_place' or 'new_bucket'");
    }
    if (config.storage.strategy === "new_bucket" && !config.storage.target_bucket) {
      errors.push("storage.target_bucket required when strategy is 'new_bucket'");
    }
  }

  // Tracks validation
  if (!config.tracks) {
    errors.push("Missing 'tracks' section");
  } else {
    if (!["legacy_folder", "merge_main", "separate_audio1"].includes(config.tracks.legacy_strategy)) {
      errors.push("tracks.legacy_strategy must be 'legacy_folder', 'merge_main', or 'separate_audio1'");
    }
    if (!["trust_files", "trust_csv", "manual_review"].includes(config.tracks.mismatch_strategy)) {
      errors.push("tracks.mismatch_strategy must be 'trust_files', 'trust_csv', or 'manual_review'");
    }
  }

  // Content validation
  if (!config.content) {
    errors.push("Missing 'content' section");
  } else {
    if (!["skip", "create_placeholder", "manual_review"].includes(config.content.no_audio_strategy)) {
      errors.push("content.no_audio_strategy must be 'skip', 'create_placeholder', or 'manual_review'");
    }
  }

  // Validation settings
  if (config.validation) {
    if (config.validation.min_success_rate < 0 || config.validation.min_success_rate > 1) {
      errors.push("validation.min_success_rate must be between 0 and 1");
    }
  }

  // Execution settings
  if (config.execution) {
    if (config.execution.batch_size < 1) {
      errors.push("execution.batch_size must be at least 1");
    }
    if (config.execution.s3_concurrency < 1) {
      errors.push("execution.s3_concurrency must be at least 1");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Get default configuration (matches migration-decisions.yaml defaults)
 */
export function getDefaultConfig(): MigrationConfig {
  return {
    storage: {
      strategy: "new_bucket",
      target_bucket: "padmakara-pt-sample",
      folder_pattern: "events/{eventCode}/{folder}/{filename}",
      delete_zips_after_extraction: false,
    },
    tracks: {
      legacy_strategy: "legacy_folder",
      mismatch_strategy: "trust_files",
    },
    content: {
      no_audio_strategy: "create_placeholder",
      auto_discover_transcripts: true,
      create_transcript_metadata_only: true,
    },
    mapping: {
      unmapped_strategy: "infer",
      infer_teachers: true,
      infer_places: true,
    },
    validation: {
      min_success_rate: 0.95,
      fail_fast: false,
      generate_html_report: true,
      preflight_checks: [
        "s3_connectivity",
        "database_connectivity",
        "bucket_permissions",
        "csv_integrity",
      ],
    },
    execution: {
      batch_size: 50,
      batch_delay_ms: 100,
      s3_concurrency: 5,
      save_state: true,
      state_file: "migration-state.json",
      state_save_interval: 10,
    },
    rollback: {
      on_failure: "keep_partial",
      cleanup_original_bucket: false,
      archive_to_glacier: false,
      keep_migration_logs: true,
      retention_days: 90,
    },
    notifications: {
      enable_progress_logs: true,
      log_level: "info",
      notify_on_completion: false,
      notify_on_errors: true,
    },
    metadata: {
      decided_by: "",
      decision_date: "",
      approved_by: "",
      notes: "",
    },
  };
}

/**
 * Print configuration summary for review
 */
export function printConfigSummary(config: MigrationConfig): void {
  console.log("\n" + "=".repeat(80));
  console.log("📋 MIGRATION CONFIGURATION SUMMARY");
  console.log("=".repeat(80));

  console.log("\n🗄️  Storage:");
  console.log(`   Strategy: ${config.storage.strategy}`);
  if (config.storage.strategy === "new_bucket") {
    console.log(`   Target Bucket: ${config.storage.target_bucket}`);
  }
  console.log(`   Delete ZIPs: ${config.storage.delete_zips_after_extraction ? "Yes" : "No"}`);

  console.log("\n📦 Tracks:");
  console.log(`   Legacy Strategy: ${config.tracks.legacy_strategy}`);
  console.log(`   Mismatch Strategy: ${config.tracks.mismatch_strategy}`);

  console.log("\n📄 Content:");
  console.log(`   No Audio Strategy: ${config.content.no_audio_strategy}`);
  console.log(`   Auto-discover Transcripts: ${config.content.auto_discover_transcripts ? "Yes" : "No"}`);

  console.log("\n🔍 Mapping:");
  console.log(`   Unmapped Strategy: ${config.mapping.unmapped_strategy}`);
  console.log(`   Infer Teachers: ${config.mapping.infer_teachers ? "Yes" : "No"}`);
  console.log(`   Infer Places: ${config.mapping.infer_places ? "Yes" : "No"}`);

  console.log("\n⚙️  Execution:");
  console.log(`   Batch Size: ${config.execution.batch_size}`);
  console.log(`   S3 Concurrency: ${config.execution.s3_concurrency}`);
  console.log(`   Save State: ${config.execution.save_state ? "Yes" : "No"}`);

  console.log("\n🔄 Rollback:");
  console.log(`   On Failure: ${config.rollback.on_failure}`);
  console.log(`   Cleanup Original: ${config.rollback.cleanup_original_bucket ? "Yes" : "No"}`);

  if (config.metadata.decided_by || config.metadata.decision_date) {
    console.log("\n📝 Metadata:");
    if (config.metadata.decided_by) {
      console.log(`   Decided By: ${config.metadata.decided_by}`);
    }
    if (config.metadata.decision_date) {
      console.log(`   Decision Date: ${config.metadata.decision_date}`);
    }
    if (config.metadata.approved_by) {
      console.log(`   Approved By: ${config.metadata.approved_by}`);
    }
  }

  console.log("\n" + "=".repeat(80) + "\n");
}
