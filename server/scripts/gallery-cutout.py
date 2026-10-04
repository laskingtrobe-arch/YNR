"""Cut the people out of photos for the poster sections (gallery-fx.js runs
this; it needs Python with rembg, and rembg's isnet-general-use model, which
it downloads to ~/.u2net the first time).

    python scripts/gallery-cutout.py <in.webp> <out.png> [<in> <out> ...]

Writes each photo as a PNG with everything but the person transparent.
"""
import sys

from PIL import Image
from rembg import new_session, remove

session = new_session('isnet-general-use')
for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
    photo = Image.open(src).convert('RGB')
    remove(photo, session=session, post_process_mask=True).save(dst)
    print(dst)
