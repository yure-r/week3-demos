import os
import json
import requests

# Path to your JSON file
JSON_FILE = "apple_emojis.json"
OUTPUT_DIR = "emoji_images"

def download_images():
    # Make sure output directory exists
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Load JSON data
    with open(JSON_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    for key, info in data.items():
        name = info.get("name", key)
        image_url = info.get("image")

        if not image_url:
            print(f"⚠️ No image URL for {name}")
            continue

        # File extension (e.g., .png, .webp)
        ext = os.path.splitext(image_url.split("?")[0])[1]
        if not ext:
            ext = ".png"

        # Output filename
        filename = f"{key}{ext}"
        filepath = os.path.join(OUTPUT_DIR, filename)

        # Skip if already exists
        if os.path.exists(filepath):
            print(f"✅ Skipping (already exists): {filename}")
            continue

        try:
            print(f"⬇️ Downloading {name} → {filename}")
            response = requests.get(image_url, timeout=10)
            response.raise_for_status()
            with open(filepath, "wb") as img_file:
                img_file.write(response.content)
        except Exception as e:
            print(f"❌ Failed to download {name}: {e}")

if __name__ == "__main__":
    download_images()
