"""Generates the built-in memorial tones (public-domain melodies and original pieces).
Run: python3 scripts/make-tones.py   (needs numpy and ffmpeg)"""
import numpy as np, subprocess, os, wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'tones')
os.makedirs(OUT, exist_ok=True)
NOTES = {'C': -9, 'C#': -8, 'Db': -8, 'D': -7, 'D#': -6, 'Eb': -6, 'E': -5, 'F': -4, 'F#': -3, 'Gb': -3, 'G': -2, 'G#': -1, 'Ab': -1, 'A': 0, 'A#': 1, 'Bb': 1, 'B': 2}

def freq(n):
    name, octv = n[:-1], int(n[-1])
    return 440.0 * 2 ** ((NOTES[name] + (octv - 4) * 12) / 12)

def env(n, a=0.08, r=0.35):
    e = np.ones(n); ai = min(int(a * SR), n // 2); ri = min(int(r * SR), n // 2)
    e[:ai] = np.linspace(0, 1, ai) if ai else 1
    e[n - ri:] *= np.linspace(1, 0, ri)
    return e

def organ(f, dur, vol=0.25, bright=1.0):
    t = np.arange(int(dur * SR)) / SR
    w = (np.sin(2*np.pi*f*t) + 0.5*bright*np.sin(2*np.pi*2*f*t) + 0.25*bright*np.sin(2*np.pi*3*f*t) + 0.12*np.sin(2*np.pi*4*f*t))
    w *= 1 + 0.003*np.sin(2*np.pi*5.2*t)  # gentle tremulant
    return vol * w * env(len(t), 0.06, min(0.5, dur*0.4))

def strings(f, dur, vol=0.2):
    t = np.arange(int(dur * SR)) / SR
    w = sum(np.sin(2*np.pi*f*(1+d)*t + p) for d, p in [(0, 0), (0.003, 1), (-0.004, 2)]) / 3
    w = w + 0.3*np.sin(2*np.pi*2*f*t)
    return vol * w * env(len(t), 0.4, min(1.2, dur*0.5))

def reverb(x, secs=2.8, mix=0.35):
    n = int(secs * SR)
    rng = np.random.default_rng(7)
    ir = rng.standard_normal(n) * np.exp(-np.linspace(0, 7, n))
    ir /= np.abs(ir).sum() / 6
    L = len(x) + n
    y = np.fft.irfft(np.fft.rfft(x, L) * np.fft.rfft(ir, L), L)[:L]
    out = np.zeros(L); out[:len(x)] = x * (1 - mix); out += y * mix
    return out

def render(melody, bpm, voice, chords=None, chord_voice=None):
    beat = 60 / bpm
    total = max(sum(d for _, d in melody), sum(d for _, d in (chords or []))) * beat + 3
    buf = np.zeros(int(total * SR) + SR)
    t = 0.0
    for n, d in melody:
        if n != 'R':
            s = voice(freq(n), d * beat * 1.02)
            i = int(t * SR); buf[i:i+len(s)] += s
        t += d * beat
    if chords:
        t = 0.0
        for ch, d in chords:
            for n in ch:
                s = chord_voice(freq(n), d * beat * 1.05)
                i = int(t * SR); buf[i:i+len(s)] += s
            t += d * beat
    return buf

def save(name, x):
    x = reverb(x)
    fade = int(3 * SR); x[-fade:] *= np.linspace(1, 0, fade)
    x = x / (np.abs(x).max() + 1e-9) * 0.7
    st = np.stack([x, np.roll(x, 300)], 1)
    wav = os.path.join(OUT, name + '.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-b:a', '128k', os.path.join(OUT, name + '.mp3')], check=True)
    os.remove(wav)
    print('made', name)

# Amazing Grace (John Newton, 1779; tune "New Britain"), public domain. 3/4 in G.
ag = [('D4',1),('G4',2),('B4',.5),('G4',.5),('B4',2),('A4',1),('G4',2),('E4',1),('D4',2),('D4',1),
      ('G4',2),('B4',.5),('G4',.5),('B4',2),('A4',1),('D5',3),('R',2),('B4',1),
      ('D5',1.5),('B4',.5),('D5',.5),('B4',.5),('G4',2),('D4',1),('E4',1.5),('G4',.5),('G4',.5),('E4',.5),('D4',2),('D4',1),
      ('G4',2),('B4',.5),('G4',.5),('B4',2),('A4',1),('G4',3),('R',3)]
ag_ch = [(('G2','D3'),1),(('G2','B2','D3'),3),(('G2','B2','D3'),3),(('C3','E3','G3'),3),(('G2','B2','D3'),3),
         (('G2','B2','D3'),3),(('G2','B2','D3'),3),(('D3','F#3','A3'),3),(('D3','F#3','A3'),3),
         (('G2','B2','D3'),3),(('G2','B2','D3'),3),(('C3','E3','G3'),3),(('G2','B2','D3'),3),(('G2','B2','D3'),3),(('D3','F#3','A3'),3),(('G2','B2','D3'),6)]
save('amazing-grace', render(ag*2, 58, lambda f,d: organ(f,d,0.22), ag_ch*2, lambda f,d: organ(f,d,0.07,0.4)))

# Taps (US Army bugle call, 1862), public domain. Played softly on strings.
tp = [('G3',.75),('G3',.25),('C4',3),('G3',.75),('C4',.25),('E4',3),('G3',.75),('C4',.25),('E4',1),('G3',.75),('C4',.25),('E4',1),
      ('G3',.75),('C4',.25),('E4',3),('C4',.75),('E4',.25),('G4',2),('E4',1),('C4',1),('G3',2),('G3',.75),('G3',.25),('C4',4),('R',3)]
save('taps', render(tp*2, 46, lambda f,d: strings(f,d,0.3)))

# Originals
ss = []
for ch in [('C3','G3','E4'),('A2','E3','C4'),('F2','C3','A3'),('G2','D3','B3'),('C3','G3','E4'),('E2','B2','G3'),('F2','C3','A3'),('G2','D3','B3')]:
    ss.append((ch, 6))
save('evening-stillness', render([('R', 48)], 60, organ, ss, lambda f,d: strings(f,d,0.16)))

lr = [('E4',2),('G4',1),('A4',3),('G4',1),('E4',1),('D4',2),('C4',2),('D4',1),('E4',3),('R',2),
      ('E4',2),('G4',1),('A4',2),('C5',1),('B4',2),('A4',1),('G4',3),('E4',1),('D4',1),('C4',4),('R',2)]
lr_ch = [(('C3','G3'),6),(('A2','E3'),6),(('F2','C3'),5),(('G2','D3'),5),(('C3','G3'),6),(('F2','C3'),6),(('G2','D3'),5),(('C3','G3'),7)]
save('long-road-home', render(lr*2, 64, lambda f,d: organ(f,d,0.2,0.6), lr_ch*2, lambda f,d: strings(f,d,0.12)))

ql = [('A4',1),('C5',1),('E5',2),('D5',1),('C5',1),('B4',2),('A4',1),('G4',1),('A4',4),('R',1),
      ('E5',1),('F5',1),('E5',2),('C5',1),('D5',1),('B4',2),('G4',1),('B4',1),('A4',4),('R',2)]
ql_ch = [(('A2','E3','C4'),4),(('E2','B2','G3'),4),(('F2','C3','A3'),4),(('A2','E3','C4'),5),(('C3','G3','E4'),4),(('G2','D3','B3'),4),(('E2','B2','G#3'),4),(('A2','E3','C4'),6)]
save('quiet-lantern', render(ql*2, 52, lambda f,d: strings(f,d,0.26), ql_ch*2, lambda f,d: organ(f,d,0.06,0.3)))
