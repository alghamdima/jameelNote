import React from 'react';
import { HardDrive, Sparkles, Cloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function WelcomeStep() {
  const { goNext } = useOnboarding();

  // Transcription and summaries run on the JameelNote service, so this must not
  // promise on-device or offline processing. Recordings, transcripts, and
  // summaries are still stored locally.
  const features = [
    {
      icon: HardDrive,
      title: 'Recordings and notes are saved on your device',
    },
    {
      icon: Sparkles,
      title: 'Intelligent summaries & insights',
    },
    {
      icon: Cloud,
      title: 'Nothing to download — transcription and summaries run on the JameelNote service',
    },
  ];

  return (
    <OnboardingContainer
      title="Welcome to JameelNote"
      description="Record. Transcribe. Summarize."
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Divider */}
        <div className="w-16 h-px bg-gray-300" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-gray-700" />
                  </div>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{feature.title}</p>
              </div>
            );
          })}
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={goNext}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            Get Started
          </Button>
          <p className="text-xs text-center text-gray-500">Takes about a minute</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
