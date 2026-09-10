// audio/transcription/wav.rs
//
// Minimal 16 kHz mono 16-bit PCM WAV encoder.
//
// Every transcription path in this app converges on 16 kHz mono f32 — the live
// pipeline mixes to it, and decoder.rs `to_whisper_format()` resamples batch audio
// to it — so the header is a fixed 44 bytes and the only variable is the sample
// count. That is why this is hand-rolled rather than pulling `hound` back in
// (see the note at Cargo.toml where it was deliberately removed).

pub const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const HEADER_BYTES: usize = 44;

/// Encode 16 kHz mono f32 samples as a complete in-memory WAV file.
///
/// The worst case caller is a 25-second batch segment, which produces about
/// 800 KB — comfortably inside any proxy body limit, so no streaming upload is
/// needed.
pub fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    let data_size = (samples.len() * 2) as u32;
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    let byte_rate = SAMPLE_RATE * block_align as u32;

    let mut out = Vec::with_capacity(HEADER_BYTES + samples.len() * 2);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_size).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format tag: PCM
    out.extend_from_slice(&CHANNELS.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_size.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&f32_to_i16(sample).to_le_bytes());
    }

    out
}

/// Convert one f32 sample to 16-bit PCM.
///
/// Three things a bare `as i16` gets wrong, all of which matter here:
///   - Range: the mixer and gain stages do not guarantee [-1, 1], and
///     1.0000001 * 32768 wraps to i16::MIN — a full-scale peak becomes a
///     full-scale trough. Clamp first.
///   - Scale: multiplying by 32767 rather than 32768 maps +1.0 onto i16::MAX
///     exactly instead of overflowing.
///   - Rounding: `as i16` truncates toward zero, biasing every sample toward
///     silence by up to half an LSB.
///
/// No dither: it would raise the noise floor by roughly 3 dB to remove
/// quantization correlation that speech models are not sensitive to.
#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    // Resamplers can emit NaN or infinity on degenerate input.
    if !sample.is_finite() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_size_field(wav: &[u8]) -> u32 {
        u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]])
    }

    fn sample_at(wav: &[u8], index: usize) -> i16 {
        let offset = HEADER_BYTES + index * 2;
        i16::from_le_bytes([wav[offset], wav[offset + 1]])
    }

    #[test]
    fn empty_input_produces_a_bare_header() {
        let wav = encode_wav_16k_mono(&[]);
        assert_eq!(wav.len(), HEADER_BYTES);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(data_size_field(&wav), 0);
    }

    #[test]
    fn header_declares_the_actual_payload_size() {
        let wav = encode_wav_16k_mono(&[0.0; 100]);
        assert_eq!(wav.len(), HEADER_BYTES + 200);
        assert_eq!(data_size_field(&wav), 200);

        // RIFF size covers everything after the first 8 bytes.
        let riff_size = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff_size as usize, wav.len() - 8);
    }

    #[test]
    fn header_declares_16khz_mono_16bit() {
        let wav = encode_wav_16k_mono(&[0.0]);
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1); // mono
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]), 32_000); // byte rate
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2); // block align
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16); // bits per sample
    }

    #[test]
    fn full_scale_maps_to_the_i16_extremes() {
        let wav = encode_wav_16k_mono(&[1.0, -1.0]);
        assert_eq!(sample_at(&wav, 0), 32767);
        assert_eq!(sample_at(&wav, 1), -32767);
    }

    #[test]
    fn out_of_range_input_clamps_instead_of_wrapping() {
        // Without the clamp these would wrap to the opposite extreme.
        let wav = encode_wav_16k_mono(&[2.0, -2.0, 1.0000001, -1.0000001]);
        assert_eq!(sample_at(&wav, 0), 32767);
        assert_eq!(sample_at(&wav, 1), -32767);
        assert_eq!(sample_at(&wav, 2), 32767);
        assert_eq!(sample_at(&wav, 3), -32767);
    }

    #[test]
    fn non_finite_input_becomes_silence() {
        let wav = encode_wav_16k_mono(&[f32::NAN, f32::INFINITY, f32::NEG_INFINITY]);
        assert_eq!(sample_at(&wav, 0), 0);
        assert_eq!(sample_at(&wav, 1), 0);
        assert_eq!(sample_at(&wav, 2), 0);
    }

    #[test]
    fn conversion_rounds_rather_than_truncating() {
        // 0.5 * 32767 = 16383.5, which truncation would drag down to 16383.
        let wav = encode_wav_16k_mono(&[0.5]);
        assert_eq!(sample_at(&wav, 0), 16384);
    }
}
