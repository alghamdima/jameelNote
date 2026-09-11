import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Eye, EyeOff, Lock, Unlock, CheckCircle2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from './ui/switch';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';


export interface TranscriptModelProps {
    provider: 'remoteWhisper' | 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

/** Shape of transcript_settings.transcriptCustomConfig, as returned by Rust. */
interface RemoteTranscriptionConfig {
    endpoint: string;
    apiKey?: string | null;
    model: string;
    /** Missing on configs saved before this option existed, which means "shared". */
    shareSummaryConnection?: boolean | null;
}

/** The part of the Summary engine's custom server config transcription reuses. */
interface SummaryConnection {
    endpoint: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
    const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
    const [showApiKey, setShowApiKey] = useState<boolean>(false);
    const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(true);
    const [isLockButtonVibrating, setIsLockButtonVibrating] = useState<boolean>(false);
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);

    // Sync uiProvider when backend config changes (e.g., after model selection or initial load)
    useEffect(() => {
        setUiProvider(transcriptModelConfig.provider);
    }, [transcriptModelConfig.provider]);

    useEffect(() => {
        if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet') {
            setApiKey(null);
        }
    }, [transcriptModelConfig.provider]);

    // The remote gateway's settings live in their own JSON blob rather than in the
    // per-provider API key columns, so they are loaded and saved separately.
    const [remoteConfig, setRemoteConfig] = useState({
        endpoint: '',
        apiKey: '',
        model: '',
        shareSummaryConnection: true,
    });
    // The Summary engine's server, shown read-only while transcription shares it.
    const [summaryConnection, setSummaryConnection] = useState<SummaryConnection | null>(null);
    const [isSavingRemote, setIsSavingRemote] = useState(false);
    const [isTestingRemote, setIsTestingRemote] = useState(false);

    useEffect(() => {
        if (uiProvider !== 'remoteWhisper') return;
        let cancelled = false;
        (async () => {
            try {
                const [config, summary] = await Promise.all([
                    invoke<RemoteTranscriptionConfig>('api_get_remote_transcription_config'),
                    invoke<SummaryConnection | null>('api_get_custom_openai_config').catch(() => null),
                ]);
                if (cancelled) return;
                setRemoteConfig({
                    endpoint: config.endpoint ?? '',
                    // A blank key means "use the built-in one"; show it as blank
                    // rather than inventing a placeholder value.
                    apiKey: config.apiKey ?? '',
                    model: config.model ?? '',
                    shareSummaryConnection: config.shareSummaryConnection ?? true,
                });
                setSummaryConnection(summary?.endpoint?.trim() ? summary : null);
            } catch (err) {
                console.error('Error fetching remote transcription config:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [uiProvider]);

    const isSharingSummaryConnection = remoteConfig.shareSummaryConnection;
    // Mirrors resolve_remote_config in Rust: while shared, the Summary server is
    // used whenever one is configured.
    const effectiveEndpoint = isSharingSummaryConnection && summaryConnection
        ? summaryConnection.endpoint
        : remoteConfig.endpoint;
    const isRemoteConfigIncomplete =
        !remoteConfig.model.trim() || (!isSharingSummaryConnection && !remoteConfig.endpoint.trim());

    const handleSaveRemoteConfig = async () => {
        if (isRemoteConfigIncomplete) return;
        setIsSavingRemote(true);
        try {
            await invoke('api_save_remote_transcription_config', {
                // The transcription-only endpoint and key are kept even while the
                // Summary connection is shared, so turning sharing off restores them.
                endpoint: remoteConfig.endpoint.trim(),
                apiKey: remoteConfig.apiKey?.trim() ? remoteConfig.apiKey.trim() : null,
                model: remoteConfig.model.trim(),
                shareSummaryConnection: isSharingSummaryConnection,
            });
            // Saving also switches the active provider, so mirror that locally.
            setTranscriptModelConfig({
                ...transcriptModelConfig,
                provider: 'remoteWhisper',
                model: remoteConfig.model.trim(),
            });
            toast.success('Transcription settings saved');
        } catch (err) {
            console.error('Error saving remote transcription config:', err);
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            setIsSavingRemote(false);
        }
    };

    const handleTestRemoteConnection = async () => {
        if (isRemoteConfigIncomplete) return;
        setIsTestingRemote(true);
        try {
            const result = await invoke<{ message?: string }>('api_test_remote_transcription_connection', {
                endpoint: remoteConfig.endpoint.trim(),
                apiKey: remoteConfig.apiKey?.trim() ? remoteConfig.apiKey.trim() : null,
                model: remoteConfig.model.trim(),
                useSummaryConnection: isSharingSummaryConnection,
            });
            toast.success(result?.message || 'Connection successful!');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            setIsTestingRemote(false);
        }
    };

    const fetchApiKey = async (provider: string) => {
        try {

            const data = await invoke('api_get_transcript_api_key', { provider }) as string;

            setApiKey(data || '');
        } catch (err) {
            console.error('Error fetching API key:', err);
            setApiKey(null);
        }
    };
    const modelOptions = {
        remoteWhisper: [], // Model name is a free-text field in the remote panel
        localWhisper: [], // Model selection handled by ModelManager component
        parakeet: [], // Model selection handled by ParakeetModelManager component
        deepgram: ['nova-2-phonecall'],
        elevenLabs: ['eleven_multilingual_v2'],
        groq: ['llama-3.3-70b-versatile'],
        openai: ['gpt-4o'],
    };
    const requiresApiKey = transcriptModelConfig.provider === 'deepgram' || transcriptModelConfig.provider === 'elevenLabs' || transcriptModelConfig.provider === 'openai' || transcriptModelConfig.provider === 'groq';

    const handleInputClick = () => {
        if (isApiKeyLocked) {
            setIsLockButtonVibrating(true);
            setTimeout(() => setIsLockButtonVibrating(false), 500);
        }
    };

    const handleWhisperModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'localWhisper', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const handleParakeetModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'parakeet', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    return (
        <div>
            <div>
                {/* <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Transcript Settings</h3>
                </div> */}
                <div className="space-y-4 pb-6">
                    <div>
                        <Label className="block text-sm font-medium text-gray-700 mb-1">
                            Transcription Model
                        </Label>
                        <div className="flex space-x-2 mx-1">
                            <Select
                                value={uiProvider}
                                onValueChange={(value) => {
                                    const provider = value as TranscriptModelProps['provider'];
                                    setUiProvider(provider);
                                    // remoteWhisper keeps its key in its own JSON blob, so it is
                                    // not fetched through api_get_transcript_api_key.
                                    if (provider !== 'localWhisper' && provider !== 'parakeet' && provider !== 'remoteWhisper') {
                                        fetchApiKey(provider);
                                    }
                                }}
                            >
                                <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                    <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="remoteWhisper">☁️ JameelNote Cloud (Default — no download)</SelectItem>
                                    <SelectItem value="parakeet">⚡ Parakeet (Real-time)</SelectItem>
                                    <SelectItem value="localWhisper">🏠 Local Whisper (Offline)</SelectItem>
                                    {/* <SelectItem value="deepgram">☁️ Deepgram (Backup)</SelectItem>
                                    <SelectItem value="elevenLabs">☁️ ElevenLabs</SelectItem>
                                    <SelectItem value="groq">☁️ Groq</SelectItem>
                                    <SelectItem value="openai">☁️ OpenAI</SelectItem> */}
                                </SelectContent>
                            </Select>

                            {uiProvider !== 'localWhisper' && uiProvider !== 'parakeet' && uiProvider !== 'remoteWhisper' && (
                                <Select
                                    value={transcriptModelConfig.model}
                                    onValueChange={(value) => {
                                        const model = value as TranscriptModelProps['model'];
                                        setTranscriptModelConfig({ ...transcriptModelConfig, provider: uiProvider, model });
                                    }}
                                >
                                    <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {modelOptions[uiProvider].map((model) => (
                                            <SelectItem key={model} value={model}>{model}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                        </div>
                    </div>

                    {uiProvider === 'remoteWhisper' && (
                        <div className="space-y-4 border-t pt-4 mx-1">
                            <p className="text-xs text-muted-foreground">
                                Meeting audio is sent to this server for transcription. Nothing is
                                downloaded to this computer.
                            </p>

                            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                                <div>
                                    <Label htmlFor="share-summary-connection">Use the Summary server and key</Label>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Connects with the same endpoint and API key as Summary, so the
                                        key only has to be entered once.
                                    </p>
                                </div>
                                <Switch
                                    id="share-summary-connection"
                                    checked={isSharingSummaryConnection}
                                    onCheckedChange={(checked) =>
                                        setRemoteConfig({ ...remoteConfig, shareSummaryConnection: checked })
                                    }
                                />
                            </div>

                            {isSharingSummaryConnection ? (
                                <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
                                    <p>
                                        <span className="font-medium text-foreground">Endpoint: </span>
                                        {effectiveEndpoint || 'Built-in JameelNote server'}
                                    </p>
                                    <p>
                                        <span className="font-medium text-foreground">API key: </span>
                                        {summaryConnection?.apiKey?.trim() ? 'From Summary settings' : 'Built-in key'}
                                    </p>
                                    <p>To change these, open the Summary tab.</p>
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <Label htmlFor="transcription-endpoint">Endpoint URL *</Label>
                                        <Input
                                            id="transcription-endpoint"
                                            value={remoteConfig.endpoint}
                                            onChange={(e) => setRemoteConfig({ ...remoteConfig, endpoint: e.target.value })}
                                            placeholder="https://opsai.aljfs.com/v1"
                                            className="mt-1"
                                        />
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Base URL of the OpenAI-compatible API. The app appends /audio/transcriptions.
                                        </p>
                                    </div>

                                    <div>
                                        <Label htmlFor="transcription-api-key">API Key (optional)</Label>
                                        <div className="relative mt-1">
                                            <Input
                                                id="transcription-api-key"
                                                type={showApiKey ? 'text' : 'password'}
                                                value={remoteConfig.apiKey || ''}
                                                onChange={(e) => setRemoteConfig({ ...remoteConfig, apiKey: e.target.value })}
                                                placeholder="Leave empty to use the built-in key"
                                                className="pr-10"
                                            />
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="absolute inset-y-0 right-0"
                                                onClick={() => setShowApiKey(!showApiKey)}
                                                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                                            >
                                                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                            </Button>
                                        </div>
                                    </div>
                                </>
                            )}

                            <div>
                                <Label htmlFor="transcription-model">Model Name *</Label>
                                <Input
                                    id="transcription-model"
                                    value={remoteConfig.model}
                                    onChange={(e) => setRemoteConfig({ ...remoteConfig, model: e.target.value })}
                                    placeholder="whisper-large-v3"
                                    className="mt-1"
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    Speech-to-text model served by this endpoint
                                </p>
                            </div>

                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handleTestRemoteConnection}
                                disabled={isRemoteConfigIncomplete || isTestingRemote}
                                className="w-full"
                            >
                                {isTestingRemote ? (
                                    <>
                                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                        Testing Connection...
                                    </>
                                ) : (
                                    <>
                                        <CheckCircle2 className="mr-2 h-4 w-4" />
                                        Test Connection
                                    </>
                                )}
                            </Button>

                            <Button
                                type="button"
                                onClick={handleSaveRemoteConfig}
                                disabled={isRemoteConfigIncomplete || isSavingRemote}
                                className="w-full"
                            >
                                {isSavingRemote ? 'Saving...' : 'Save'}
                            </Button>
                        </div>
                    )}

                    {uiProvider === 'localWhisper' && (
                        <div className="mt-6">
                            <ModelManager
                                selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleWhisperModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}

                    {uiProvider === 'parakeet' && (
                        <div className="mt-6">
                            <ParakeetModelManager
                                selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleParakeetModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}


                    {requiresApiKey && (
                        <div>
                            <Label className="block text-sm font-medium text-gray-700 mb-1">
                                API Key
                            </Label>
                            <div className="relative mx-1">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    className={`pr-24 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 ${isApiKeyLocked ? 'bg-gray-100 cursor-not-allowed' : ''
                                        }`}
                                    value={apiKey || ''}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    disabled={isApiKeyLocked}
                                    onClick={handleInputClick}
                                    placeholder="Enter your API key"
                                />
                                {isApiKeyLocked && (
                                    <div
                                        onClick={handleInputClick}
                                        className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50 rounded-md cursor-not-allowed"
                                    />
                                )}
                                <div className="absolute inset-y-0 right-0 pr-1 flex items-center">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                                        className={`transition-colors duration-200 ${isLockButtonVibrating ? 'animate-vibrate text-red-500' : ''
                                            }`}
                                        title={isApiKeyLocked ? "Unlock to edit" : "Lock to prevent editing"}
                                    >
                                        {isApiKeyLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                    >
                                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div >
    )
}








