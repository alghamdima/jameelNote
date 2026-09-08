'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PermissionStatus, OnboardingPermissions } from '@/types/onboarding';
// Transcription model fetched during onboarding. Must match
// DEFAULT_WHISPER_MODEL in src-tauri/src/config.rs, and the state fields below
// still carry the historical "parakeet" names because onboarding status is
// persisted with those keys.
const TRANSCRIPTION_MODEL = 'large-v3-q5_0';

// whisper_download_model reports progress as a percentage only, unlike the
// Parakeet events which carried byte counts, so the size is taken from the
// model catalog to keep showing MB in the UI.
const TRANSCRIPTION_MODEL_TOTAL_MB = 1031;

interface OnboardingStatus {
  version: string;
  completed: boolean;
  current_step: number;
  model_status: {
    parakeet: string;
    summary: string;
    selected_summary_model?: string;
  };
  last_updated: string;
}

interface SummaryModelProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
}

interface ParakeetProgressInfo {
  percent: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
}

interface OnboardingContextType {
  currentStep: number;
  parakeetDownloaded: boolean;
  parakeetProgress: number;
  parakeetProgressInfo: ParakeetProgressInfo;
  summaryModelDownloaded: boolean;
  summaryModelProgress: number;
  summaryModelProgressInfo: SummaryModelProgressInfo;
  selectedSummaryModel: string;
  recommendedSummaryModel: string;
  databaseExists: boolean;
  isBackgroundDownloading: boolean;
  // Permissions
  permissions: OnboardingPermissions;
  permissionsSkipped: boolean;
  // Navigation
  goToStep: (step: number) => void;
  goNext: () => void;
  goPrevious: () => void;
  // Setters
  setParakeetDownloaded: (value: boolean) => void;
  setSummaryModelDownloaded: (value: boolean) => void;
  setSelectedSummaryModel: (value: string) => void;
  setDatabaseExists: (value: boolean) => void;
  setPermissionStatus: (permission: keyof OnboardingPermissions, status: PermissionStatus) => void;
  setPermissionsSkipped: (skipped: boolean) => void;
  completeOnboarding: () => Promise<void>;
  startBackgroundDownloads: (options: StartBackgroundDownloadsOptions) => Promise<void>;
  retryParakeetDownload: () => Promise<void>;
}

interface StartBackgroundDownloadsOptions {
  includeParakeet: boolean;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [completed, setCompleted] = useState(false);
  const [parakeetDownloaded, setParakeetDownloaded] = useState(false);
  const [parakeetProgress, setParakeetProgress] = useState(0);
  const [parakeetProgressInfo, setParakeetProgressInfo] = useState<ParakeetProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  // No local summary model is downloaded any more, so this stage is always
  // satisfied. Kept so the persisted onboarding status keeps its shape.
  const [summaryModelDownloaded, setSummaryModelDownloaded] = useState(true);
  const [summaryModelProgress, setSummaryModelProgress] = useState(0);
  const [summaryModelProgressInfo, setSummaryModelProgressInfo] = useState<SummaryModelProgressInfo>({
    percent: 0,
    downloadedMb: 0,
    totalMb: 0,
    speedMbps: 0,
  });
  const [selectedSummaryModel, setSelectedSummaryModel] = useState<string>('');
  const [recommendedSummaryModel, setRecommendedSummaryModel] = useState<string>('');
  const [databaseExists, setDatabaseExists] = useState(false);
  const [isBackgroundDownloading, setIsBackgroundDownloading] = useState(false);

  // Permissions state
  const [permissions, setPermissions] = useState<OnboardingPermissions>({
    microphone: 'not_determined',
    systemAudio: 'not_determined',
    screenRecording: 'not_determined',
  });
  const [permissionsSkipped, setPermissionsSkipped] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout>();


  // Load status on mount and initialize database
  useEffect(() => {
    loadOnboardingStatus();
    checkDatabaseStatus();
    initializeDatabaseInBackground();
  }, []);

  // Initialize database silently in background (moved from SetupOverviewStep)
  const initializeDatabaseInBackground = async () => {
    try {
      console.log('[OnboardingContext] Starting background database initialization');
      const isFirstLaunch = await invoke<boolean>('check_first_launch');

      if (!isFirstLaunch) {
        console.log('[OnboardingContext] Database exists, skipping initialization');
        setDatabaseExists(true);
        return;
      }

      // First launch - attempt auto-detection and import
      await performAutoDetection();
    } catch (error) {
      console.error('[OnboardingContext] Database initialization failed:', error);
      // Don't throw - database init failure shouldn't block onboarding
    }
  };

  const performAutoDetection = async () => {
    // Check Homebrew (macOS only)
    if (typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac')) {
      const homebrewDbPath = '/usr/local/var/meetily/meeting_minutes.db';
      try {
        const homebrewCheck = await invoke<{ exists: boolean; size: number } | null>(
          'check_homebrew_database',
          { path: homebrewDbPath }
        );

        if (homebrewCheck?.exists) {
          console.log('[OnboardingContext] Found Homebrew database, importing');
          await invoke('import_and_initialize_database', { legacyDbPath: homebrewDbPath });
          setDatabaseExists(true);
          return;
        }
      } catch (e) {
        console.log('[OnboardingContext] Homebrew check failed, continuing:', e);
      }
    }

    // Check default legacy database location
    try {
      const legacyPath = await invoke<string | null>('check_default_legacy_database');
      if (legacyPath) {
        console.log('[OnboardingContext] Found legacy database, importing');
        await invoke('import_and_initialize_database', { legacyDbPath: legacyPath });
        setDatabaseExists(true);
        return;
      }
    } catch (e) {
      console.log('[OnboardingContext] Legacy check failed, continuing:', e);
    }

    // No legacy database found - initialize fresh
    console.log('[OnboardingContext] No legacy database found, initializing fresh');
    await invoke('initialize_fresh_database');
    setDatabaseExists(true);
  };

  const isCompletingRef = useRef(false);

  // Auto-save on state change (debounced)
  useEffect(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    // Don't auto-save if completed (to avoid overwriting completion status)
    // Also don't auto-save if we are currently in the process of completing
    if (completed || isCompletingRef.current) return;

    saveTimeoutRef.current = setTimeout(() => {
      saveOnboardingStatus();
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [currentStep, parakeetDownloaded, summaryModelDownloaded, completed]);

  // Listen to transcription model download progress
  useEffect(() => {
    const unlisten = listen<{
      modelName: string;
      progress: number;
    }>(
      'model-download-progress',
      (event) => {
        const { modelName, progress } = event.payload;
        if (modelName === TRANSCRIPTION_MODEL) {
          setParakeetProgress(progress);
          setParakeetProgressInfo({
            percent: progress,
            downloadedMb: (TRANSCRIPTION_MODEL_TOTAL_MB * progress) / 100,
            totalMb: TRANSCRIPTION_MODEL_TOTAL_MB,
            speedMbps: 0,
          });
          if (progress >= 100) {
            setParakeetDownloaded(true);
          }
        }
      }
    );

    const unlistenComplete = listen<{ modelName: string }>(
      'model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === TRANSCRIPTION_MODEL) {
          setParakeetDownloaded(true);
          setParakeetProgress(100);
        }
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'model-download-error',
      (event) => {
        const { modelName } = event.payload;
        if (modelName === TRANSCRIPTION_MODEL) {
          console.error('Transcription model download error:', event.payload.error);
        }
      }
    );

    return () => {
      unlisten.then(fn => fn());
      unlistenComplete.then(fn => fn());
      unlistenError.then(fn => fn());
    };
  }, []);

  const checkDatabaseStatus = async () => {
    try {
      const isFirstLaunch = await invoke<boolean>('check_first_launch');
      setDatabaseExists(!isFirstLaunch);
      console.log('[OnboardingContext] Database exists:', !isFirstLaunch);
    } catch (error) {
      console.error('[OnboardingContext] Failed to check database status:', error);
      setDatabaseExists(false);
    }
  };

  const loadOnboardingStatus = async () => {
    try {
      const status = await invoke<OnboardingStatus | null>('get_onboarding_status');
      if (status) {
        console.log('[OnboardingContext] Loaded saved status:', status);

        if (status.completed) {
          setCurrentStep(status.current_step);
          setCompleted(true);
          setParakeetDownloaded(status.model_status.parakeet === 'downloaded');
          console.log('[OnboardingContext] Restored completed onboarding status without model verification');
          return;
        }

        // Don't trust saved status - verify actual model status on disk
        const verifiedStatus = await verifyModelStatus(status);

        setCurrentStep(verifiedStatus.currentStep);
        setCompleted(verifiedStatus.completed);
        setParakeetDownloaded(verifiedStatus.parakeetDownloaded);

        console.log('[OnboardingContext] Verified status:', verifiedStatus);

        // Check if any downloads are active to restore isBackgroundDownloading state
        await checkActiveDownloads();
      }
    } catch (error) {
      console.error('[OnboardingContext] Failed to load onboarding status:', error);
    }
  };

  // Verify that models actually exist on disk, not just trust saved JSON
  const verifyModelStatus = async (savedStatus: OnboardingStatus) => {
    let parakeetDownloaded = false;
    // Nothing is downloaded for summaries, so this stage is always satisfied.
    const summaryModelDownloaded = true;
    const selectedSummaryModel = '';

    // Verify the transcription model exists on disk
    try {
      await invoke('whisper_init');
      parakeetDownloaded = await invoke<boolean>('whisper_has_available_models');
      console.log('[OnboardingContext] Transcription model verified on disk:', parakeetDownloaded);
    } catch (error) {
      console.warn('[OnboardingContext] Failed to verify transcription model:', error);
      parakeetDownloaded = false;
    }

    // Determine the correct step based on verified status
    // New simplified flow: Step 1: Welcome, Step 2: Setup Overview, Step 3: Download Progress, Step 4: Permissions (macOS)
    let currentStep = savedStatus.current_step;
    let completed = savedStatus.completed;

    // Clamp step to new max (4)
    if (currentStep > 4) {
      currentStep = 3; // Go to download progress step
    }

    // Trust the completed status - don't revert based on model downloads
    // Downloads continue in background; user stays in main app regardless
    return {
      currentStep,
      completed,
      parakeetDownloaded,
      summaryModelDownloaded,
      selectedSummaryModel,
    };
  };

  const saveOnboardingStatus = async () => {
    // Safety check: if we are in the process of completing, DO NOT save
    // This prevents a race condition where a download completion event triggers a save
    // that overwrites the "completed" status set by completeOnboarding
    if (isCompletingRef.current) {
      console.log('[OnboardingContext] Skipping saveOnboardingStatus because completion is in progress');
      return;
    }

    try {
      await invoke('save_onboarding_status_cmd', {
        status: {
          version: '1.0',
          completed: completed,
          current_step: currentStep,
          model_status: {
            parakeet: parakeetDownloaded ? 'downloaded' : 'not_downloaded',
            summary: summaryModelDownloaded ? 'downloaded' : 'not_downloaded',
            selected_summary_model: selectedSummaryModel || undefined,
          },
          last_updated: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[OnboardingContext] Failed to save onboarding status:', error);
    }
  };

  const completeOnboarding = async () => {
    try {
      // Set completion flag to prevent race conditions with auto-save
      isCompletingRef.current = true;

      // Clear any pending auto-saves
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = undefined;
      }

      // Summaries are generated by the configured OpenAI-compatible gateway,
      // so onboarding neither selects nor downloads a local LLM. The argument
      // is still sent because the Tauri command signature accepts it, but the
      // backend ignores it.
      await invoke('complete_onboarding', {
        model: '',
      });
      setCompleted(true);
      console.log('[OnboardingContext] Onboarding completed');

      // Reset the flag so subsequent state updates can be saved
      isCompletingRef.current = false;
    } catch (error) {
      console.error('[OnboardingContext] Failed to complete onboarding:', error);
      isCompletingRef.current = false; // Reset flag on error
      throw error; // Re-throw so PermissionsStep can handle it
    }
  };

  // Start background downloads for models.
  const startBackgroundDownloads = async ({
    includeParakeet,
  }: StartBackgroundDownloadsOptions) => {
    console.log('[OnboardingContext] Starting background downloads:', { includeParakeet });

    try {
      // Only the transcription model is fetched. Summaries run on the
      // configured OpenAI-compatible gateway, so there is no local LLM to pull.
      const shouldStartTranscription = includeParakeet && !parakeetDownloaded;

      if (!shouldStartTranscription) {
        return;
      }

      setIsBackgroundDownloading(true);

      console.log('[OnboardingContext] Starting transcription model download');
      invoke('whisper_download_model', { modelName: TRANSCRIPTION_MODEL })
        .catch(err => console.error('[OnboardingContext] Transcription model download failed:', err));
    } catch (error) {
      console.error('[OnboardingContext] Failed to start background downloads:', error);
      setIsBackgroundDownloading(false);
      throw error;
    }
  };

  // Check if the transcription model is currently downloading (for re-entry)
  const checkActiveDownloads = async () => {
    try {
      const models = await invoke<any[]>('whisper_get_available_models');
      const isDownloading = models.some(m => m.status && (typeof m.status === 'object' ? 'Downloading' in m.status : m.status === 'Downloading'));

      if (isDownloading) {
        console.log('[OnboardingContext] Detected active background downloads on mount');
        setIsBackgroundDownloading(true);
      }
    } catch (error) {
      console.warn('[OnboardingContext] Failed to check active downloads:', error);
    }
  };

  const retryParakeetDownload = async () => {
    console.log('[OnboardingContext] Retrying transcription model download');
    try {
      await invoke('whisper_download_model', { modelName: TRANSCRIPTION_MODEL });
    } catch (error) {
      console.error('[OnboardingContext] Retry failed:', error);
      throw error;
    }
  };

  const setPermissionStatus = useCallback((permission: keyof OnboardingPermissions, status: PermissionStatus) => {
    setPermissions((prev: OnboardingPermissions) => ({
      ...prev,
      [permission]: status,
    }));
  }, []);

  const goToStep = useCallback((step: number) => {
    setCurrentStep(Math.max(1, Math.min(step, 4)));
  }, []);

  const goNext = useCallback(() => {
    setCurrentStep((prev: number) => {
      const next = prev + 1;
      // Don't go past step 4
      return Math.min(next, 4);
    });
  }, []);

  const goPrevious = useCallback(() => {
    setCurrentStep((prev: number) => {
      const previous = prev - 1;
      // Don't go below step 1
      return Math.max(previous, 1);
    });
  }, []);

  return (
    <OnboardingContext.Provider
      value={{
        currentStep,
        parakeetDownloaded,
        parakeetProgress,
        parakeetProgressInfo,
        summaryModelDownloaded,
        summaryModelProgress,
        summaryModelProgressInfo,
        selectedSummaryModel,
        recommendedSummaryModel,
        databaseExists,
        isBackgroundDownloading,
        permissions,
        permissionsSkipped,
        goToStep,
        goNext,
        goPrevious,
        setParakeetDownloaded,
        setSummaryModelDownloaded,
        setSelectedSummaryModel,
        setDatabaseExists,
        setPermissionStatus,
        setPermissionsSkipped,
        completeOnboarding,
        startBackgroundDownloads,
        retryParakeetDownload,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return context;
}
