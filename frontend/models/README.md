# Local Face Model Assets

Place the following `@vladmandic/face-api` model files in this folder for fully self-contained deployment:

- `ssd_mobilenetv1_model.bin`
- `ssd_mobilenetv1_model-weights_manifest.json`
- `face_landmark_68_model.bin`
- `face_landmark_68_model-weights_manifest.json`
- `face_recognition_model.bin`
- `face_recognition_model-weights_manifest.json`

Source:

- https://cdn.jsdelivr.net/gh/vladmandic/face-api/model/

The frontend checks this folder first and falls back to the official CDN if the files are not present.
