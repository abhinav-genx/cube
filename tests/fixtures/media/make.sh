#!/bin/sh
# Makes the small video and audio fixtures for tests/media.test.mjs (ffmpeg with libx264 and libmp3lame).
# Each carries a location, a device or author name, a title and a date, the way phones and editors
# write them. Run from this directory: sh make.sh
set -e
F="ffmpeg -hide_banner -loglevel error -y"
V="-f lavfi -i testsrc=d=0.5:s=32x32:r=10 -f lavfi -i sine=d=0.5:r=8000"
DATE=2025-01-01T12:00:00.000000Z
# iPhone-style MOV: QuickTime metadata keys (mdta) in moov/meta
$F $V -c:v libx264 -preset ultrafast -c:a aac -b:a 16k -movflags use_metadata_tags \
  -metadata "com.apple.quicktime.location.ISO6709=+48.8584+002.2945+035.000/" \
  -metadata "com.apple.quicktime.make=Apple" -metadata "com.apple.quicktime.model=iPhone 15 Pro" \
  -metadata "com.apple.quicktime.software=17.4.1" -metadata "com.apple.quicktime.creationdate=2025-01-01T12:00:00+0100" \
  -metadata creation_time=$DATE video.mov
# Android-style MP4: location in udta/©xyz, title and artist in udta/meta/ilst
$F $V -c:v libx264 -preset ultrafast -c:a aac -b:a 16k \
  -metadata "location=+48.8584+002.2945/" -metadata "title=Secret plan" -metadata "artist=Jane Doe" \
  -metadata "comment=Recorded on Acme Phone" -metadata "date=2025" -metadata creation_time=$DATE video.mp4
# Voice-memo-style M4A
$F -f lavfi -i sine=d=0.5:r=8000 -c:a aac -b:a 16k -metadata "title=Main Street 5" -metadata "artist=Jane Doe" \
  -metadata "date=2025-01-01" -metadata creation_time=$DATE audio.m4a
# MP3 with ID3v2.3 and ID3v1
$F -f lavfi -i sine=d=0.5:r=8000 -c:a libmp3lame -b:a 16k -id3v2_version 3 -write_id3v1 1 \
  -metadata "title=Secret plan" -metadata "artist=Jane Doe" -metadata "comment=Acme" -metadata "date=2025" audio.mp3
# FLAC with Vorbis comments and a cover picture
$F -f lavfi -i color=c=red:s=8x8:d=1 -frames:v 1 cover.png
$F -f lavfi -i sine=d=0.5:r=8000 -i cover.png -map 0 -map 1 -c:a flac -c:v png -disposition:v attached_pic \
  -metadata "title=Secret plan" -metadata "artist=Jane Doe" -metadata "date=2025" audio.flac
rm cover.png
# WAV with LIST/INFO and a broadcast (bext) chunk
$F -f lavfi -i sine=d=0.5:r=8000 -c:a pcm_s16le -write_bext 1 -metadata "title=Secret plan" -metadata "artist=Jane Doe" \
  -metadata "originator=Acme Recorder" -metadata "description=Jane Doe interview" -metadata "date=2025" audio.wav
# AIFF with name, author, copyright, annotation and ID3 chunks
$F -f lavfi -i sine=d=0.5:r=8000 -c:a pcm_s16be -write_id3v2 1 -metadata "title=Secret plan" -metadata "author=Jane Doe" \
  -metadata "copyright=Acme" -metadata "comment=Main Street" -metadata "date=2025" audio.aiff
# Ogg Vorbis, Opus and Ogg FLAC with comments (Vorbis with ffmpeg's own encoder)
$F -f lavfi -i sine=d=0.5:r=8000 -c:a vorbis -strict -2 -ac 2 -metadata "title=Secret plan" -metadata "artist=Jane Doe" \
  -metadata "comment=Main Street" audio.ogg
$F -f lavfi -i sine=d=0.5:r=8000 -c:a libopus -b:a 16k -metadata "title=Secret plan" -metadata "artist=Jane Doe" \
  -metadata "location=48.8584" audio.opus
$F -f lavfi -i sine=d=0.5:r=8000 -c:a flac -f ogg -metadata "title=Secret plan" -metadata "artist=Jane Doe" audio.oga
# Matroska with tags, a cover image and a font attachment (the font stays), and a WebM with tags
$F -f lavfi -i color=c=red:s=8x8:d=1 -frames:v 1 cover.png
printf 'font' > font.ttf
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Jane Doe at Main Street\n' > chapters.txt
$F $V -i chapters.txt -map 0 -map 1 -map_chapters 2 -c:v libx264 -preset ultrafast -c:a vorbis -strict -2 -ac 2 \
  -metadata "title=Secret plan" -metadata "artist=Jane Doe" -metadata "location=+48.8584+002.2945/" \
  -metadata:s:v "title=Jane Doe camera" -metadata:s:a "title=Acme microphone" \
  -metadata "date=2025" -attach cover.png -metadata:s:2 mimetype=image/png -metadata:s:2 filename=cover.png \
  -attach font.ttf -metadata:s:3 mimetype=font/ttf -metadata:s:3 filename=font.ttf video.mkv
$F $V -c:v libvpx -b:v 50k -c:a libopus -b:a 16k -metadata "title=Secret plan" -metadata "artist=Jane Doe" \
  -metadata "comment=Recorded on Acme Phone" video.webm
rm cover.png font.ttf chapters.txt
# Motion-JPEG in MOV and Matroska: each frame carries a comment segment (ffmpeg's name)
$F $V -c:v mjpeg -c:a pcm_s16le video-mjpeg.mov
$F $V -c:v mjpeg -c:a flac video-mjpeg.mkv
# A drone-style MP4: a subtitle track printing the position on every frame, as DJI drones write it
printf '1\n00:00:00,000 --> 00:00:00,500\nF/2.8, SS 320, ISO 100, EV 0, GPS (8.6332, 47.4028, 21), D 6.47m, H 3.40m\n' > dji.srt
$F $V -i dji.srt -map 0 -map 1 -map 2 -c:v libx264 -preset ultrafast -c:a aac -b:a 16k -c:s mov_text video-dji.mp4
rm dji.srt
# AVI with an INFO list
$F $V -c:v mjpeg -c:a pcm_s16le -metadata "title=Secret plan" -metadata "artist=Jane Doe" -metadata "comment=Acme" video.avi
