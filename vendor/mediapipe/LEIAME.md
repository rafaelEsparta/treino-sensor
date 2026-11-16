# MediaPipe (arquivos de terceiros)

Servidos pelo próprio app para o treino livre funcionar offline. O vídeo da
câmera é processado no aparelho e nunca é enviado a lugar nenhum.

| Arquivo | Origem | Licença |
|---|---|---|
| `vision_bundle.mjs`, `wasm/vision_wasm_internal.*` | pacote npm `@mediapipe/tasks-vision` 1.2.3 | Apache-2.0 |
| `pose_landmarker_lite.task` | `storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/` | Apache-2.0 |

Para atualizar: `npm pack @mediapipe/tasks-vision`, copiar os mesmos arquivos
e subir a versão do cache em `sw.js`.
