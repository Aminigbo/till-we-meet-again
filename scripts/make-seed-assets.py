"""Generates illustrated placeholder portraits and documents used by the demo seed.
Run: python3 scripts/make-seed-assets.py  (needs Pillow; ffmpeg for the demo video)"""
import os, random, subprocess
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), 'seed-assets')
os.makedirs(OUT, exist_ok=True)
rng = random.Random(11)
SKIN = [(92, 58, 38), (120, 78, 52), (141, 94, 62), (76, 48, 32), (160, 112, 78), (104, 66, 44)]
CLOTH = [(31, 36, 54), (122, 30, 38), (40, 86, 70), (150, 110, 40), (230, 228, 220), (70, 52, 110), (25, 60, 110), (180, 80, 40)]
BG = [((200, 196, 186), (150, 146, 138)), ((176, 186, 194), (120, 130, 140)), ((196, 186, 168), (140, 126, 106)), ((168, 176, 160), (112, 122, 104))]

def portrait(i, female):
    W, H = 480, 600
    top, bot = BG[i % len(BG)]
    img = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(top[k] * (1 - t) + bot[k] * t) for k in range(3)))
    skin = SKIN[i % len(SKIN)]; cloth = CLOTH[(i * 3) % len(CLOTH)]; accent = CLOTH[(i * 5 + 2) % len(CLOTH)]
    # shoulders and clothing
    d.ellipse([40, 430, 440, 820], fill=cloth)
    d.polygon([(200, 430), (240, 520), (280, 430)], fill=skin)
    if not female and i % 2 == 0:  # agbada-style collar trim
        d.arc([150, 420, 330, 560], 20, 160, fill=accent, width=10)
    # neck and head
    d.rectangle([205, 330, 275, 450], fill=skin)
    d.ellipse([160, 150, 320, 370], fill=skin)
    d.ellipse([150, 245, 172, 290], fill=skin); d.ellipse([308, 245, 330, 290], fill=skin)
    shade = tuple(max(0, c - 25) for c in skin)
    d.ellipse([200, 255, 222, 266], fill=(40, 28, 22)); d.ellipse([258, 255, 280, 266], fill=(40, 28, 22))
    d.arc([215, 300, 265, 335], 20, 160, fill=shade, width=4)
    if female:
        if i % 3 == 0:  # gele head-tie
            d.polygon([(130, 210), (180, 90), (250, 70), (330, 95), (360, 200), (320, 190), (240, 150), (160, 195)], fill=accent)
            d.polygon([(300, 100), (380, 60), (360, 140)], fill=accent)
        else:
            d.ellipse([150, 130, 330, 250], fill=(28, 22, 20)); d.rectangle([150, 190, 175, 300], fill=(28, 22, 20)); d.rectangle([305, 190, 330, 300], fill=(28, 22, 20))
        d.ellipse([228, 455, 252, 479], fill=(214, 180, 90))
    else:
        if i % 3 == 1:  # fila cap
            d.polygon([(160, 205), (175, 120), (300, 110), (330, 170), (322, 205)], fill=accent)
        else:
            d.chord([160, 145, 320, 260], 180, 360, fill=(30, 24, 22))
        if i % 4 == 2:
            d.rectangle([196, 252, 226, 270], outline=(30, 30, 30), width=3); d.rectangle([254, 252, 284, 270], outline=(30, 30, 30), width=3); d.line([(226, 260), (254, 260)], fill=(30, 30, 30), width=3)
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    img.save(os.path.join(OUT, f'portrait-{i:02d}.jpg'), quality=86)

for i in range(24):
    portrait(i, female=(i % 2 == 0))

# A clearly-marked sample certificate (demo only)
c = Image.new('RGB', (900, 640), (250, 248, 240)); d = ImageDraw.Draw(c)
d.rectangle([20, 20, 880, 620], outline=(60, 60, 60), width=4)
try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 34); s = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
except Exception: f = s = ImageFont.load_default()
d.text((450, 80), 'SAMPLE DEATH CERTIFICATE', anchor='mm', font=f, fill=(30, 30, 30))
d.text((450, 130), 'Demo document. Not a real record.', anchor='mm', font=s, fill=(160, 40, 40))
for k, y in enumerate(range(200, 560, 50)):
    d.line([(80, y), (820, y)], fill=(170, 170, 170), width=2)
c.save(os.path.join(OUT, 'sample-certificate.png'))

# Short tribute video for the VVIP demo (slow zoom over a portrait, 20 seconds)
try:
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', os.path.join(OUT, 'portrait-03.jpg'),
                    '-vf', "scale=1280:1600,zoompan=z='min(zoom+0.0007,1.25)':d=500:s=960x540:fps=25,format=yuv420p",
                    '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', os.path.join(OUT, 'demo-video.mp4')], check=True)
except Exception as e:
    print('video skipped:', e)
print('assets in', OUT)
