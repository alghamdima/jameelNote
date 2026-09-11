import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { toast } from 'sonner';

// 'downloading' now means "checking the gateway"; the name is kept so the
// shared DownloadState shape does not change.
type DownloadStatus = 'waiting' | 'downloading' | 'completed' | 'error';

interface DownloadState {
  status: DownloadStatus;
  progress: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  error?: string;
}

export function DownloadProgressStep() {
  const {
    goNext,
    parakeetDownloaded,
    setParakeetDownloaded,
    completeOnboarding,
  } = useOnboarding();

  const [isMac, setIsMac] = useState(false);

  const [parakeetState, setParakeetState] = useState<DownloadState>({
    status: parakeetDownloaded ? 'completed' : 'waiting',
    progress: parakeetDownloaded ? 100 : 0,
    downloadedMb: 0,
    totalMb: 1031,
    speedMbps: 0,
  });

  const [isCompleting, setIsCompleting] = useState(false);
  const parakeetDownloadStartedRef = useRef(false);
  const retryingRef = useRef(false);

  // Re-check that the transcription gateway answers. Nothing is downloaded, so
  // this retries the reachability probe rather than a model fetch.
  const handleRetryDownload = async () => {
    // Prevent multiple simultaneous retries
    if (retryingRef.current) {
      console.log('[DownloadProgressStep] Retry already in progress, ignoring');
      return;
    }

    console.log('[DownloadProgressStep] Rechecking transcription gateway');
    retryingRef.current = true;

    // Reset error state
    setParakeetState((prev) => ({
      ...prev,
      status: 'downloading',
      error: undefined,
      progress: 0,
      downloadedMb: 0,
      speedMbps: 0,
    }));

    try {
      const config = await invoke<{
        endpoint: string;
        apiKey?: string | null;
        model: string;
        shareSummaryConnection?: boolean | null;
      }>('api_get_remote_transcription_config');
      await invoke('api_test_remote_transcription_connection', {
        endpoint: config.endpoint,
        apiKey: config.apiKey ?? null,
        model: config.model,
        // Test the connection recording will use, which is the Summary server
        // and key unless the user turned sharing off.
        useSummaryConnection: config.shareSummaryConnection ?? true,
      });
      setParakeetState((prev) => ({ ...prev, status: 'completed', progress: 100 }));
    } catch (error) {
      console.error('[DownloadProgressStep] Gateway check failed:', error);
      setParakeetState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Connection check failed',
      }));

      toast.error('Could not reach the transcription service', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      // Allow retry again after 2 seconds
      setTimeout(() => {
        retryingRef.current = false;
      }, 2000);
    }
  };

  // Detect platform on mount
  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };

    checkPlatform();
  }, []);

  // Transcription runs on the configured gateway, so there is no model to fetch.
  // Check that the gateway answers instead, which takes seconds rather than the
  // ~1 GB download this step used to perform.
  useEffect(() => {
    if (parakeetDownloadStartedRef.current) return;
    parakeetDownloadStartedRef.current = true;

    setParakeetState((prev) => ({ ...prev, status: 'downloading' }));

    (async () => {
      try {
        const config = await invoke<{
          endpoint: string;
          apiKey?: string | null;
          model: string;
          shareSummaryConnection?: boolean | null;
        }>('api_get_remote_transcription_config');
        await invoke('api_test_remote_transcription_connection', {
          endpoint: config.endpoint,
          apiKey: config.apiKey ?? null,
          model: config.model,
          useSummaryConnection: config.shareSummaryConnection ?? true,
        });
        setParakeetDownloaded(true);
        setParakeetState((prev) => ({ ...prev, status: 'completed', progress: 100 }));
      } catch (error) {
        // Deliberately non-blocking: a first run behind a captive portal or a
        // briefly unreachable gateway should not trap the user in onboarding.
        // handleContinue lets them through, and Settings has a Test Connection
        // button for when they want to check again.
        console.warn('Transcription gateway check failed:', error);
        setParakeetDownloaded(true);
        setParakeetState((prev) => ({ ...prev, status: 'error', error: String(error) }));
      }
    })();
  }, []);

  const handleContinue = async () => {
    // Nothing is downloaded any more, so there is no local model to verify. A
    // failed reachability check is surfaced as a warning rather than a block:
    // the gateway may simply be unreachable right now.
    if (parakeetState.status === 'error') {
      toast.warning('Could not reach the transcription service', {
        description: 'Setup will continue. You can test the connection in Settings > Transcription.',
        duration: 6000,
      });
    }

    if (isMac) {
      // macOS: Go to Permissions step (will complete after permissions granted)
      goNext();
    } else {
      // Non-macOS: Complete onboarding immediately (downloads continue in background)
      setIsCompleting(true);
      try {
        await completeOnboarding();

        // Small delay to ensure state is saved before reload
        await new Promise(resolve => setTimeout(resolve, 100));

        window.location.reload();
      } catch (error) {
        console.error('Failed to complete onboarding:', error);
        toast.error('Failed to complete setup', {
          description: 'Please try again.',
        });
        setIsCompleting(false);
      }
    }
  };

  const renderServiceCard = (
    title: string,
    icon: React.ReactNode,
    state: DownloadState,
    subtitle: string
  ) => (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
            {icon}
          </div>
          <div>
            <h3 className="font-medium text-gray-900">{title}</h3>
            <p className="text-sm text-gray-500">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state.status === 'waiting' && (
            <span className="text-sm text-gray-500">Waiting...</span>
          )}
          {state.status === 'downloading' && (
            <>
              <span className="text-sm text-gray-500">Checking connection...</span>
              <Loader2 className="w-5 h-5 text-gray-700 animate-spin" />
            </>
          )}
          {state.status === 'completed' && (
            <>
              <span className="text-sm text-green-700">Connected</span>
              <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600" />
              </div>
            </>
          )}
          {state.status === 'error' && (
            <span className="text-sm text-red-500">Not reachable</span>
          )}
        </div>
      </div>
      {/* No progress bar: nothing is downloaded, so there are no bytes to count. */}

      {state.status === 'error' && state.error && (
        <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-600 font-medium">Could not reach the transcription service</p>
          <p className="text-xs text-red-500 mt-1">{state.error}</p>
          <p className="text-xs text-gray-600 mt-1">You can still continue, and test the connection later in Settings.</p>
          <button
            onClick={handleRetryDownload}
            className="mt-3 w-full h-9 px-4 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Try Again
          </button>
        </div>
      )}
    </div>
  );

  return (
    <OnboardingContainer
      title="Getting things ready"
      description="JameelNote transcribes through its online service, so there is nothing to download. Checking that it can be reached."
      step={3}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-6">
        {/* Download Cards */}
        <div className="w-full max-w-lg space-y-4">
          {/* Both transcription and summaries run on the configured
              OpenAI-compatible server, so nothing is downloaded here. */}
          {renderServiceCard(
            'Transcription Service',
            <Mic className="w-5 h-5 text-gray-600" />,
            parakeetState,
            'No download'
          )}
        </div>

        {/* Continue Button */}
        <div className="w-full max-w-xs">
          <Button
            onClick={handleContinue}
            disabled={!parakeetDownloaded || isCompleting}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(isCompleting || !parakeetDownloaded) ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              'Continue'
            )}
          </Button>
        </div>
      </div>
    </OnboardingContainer>
  );
}
