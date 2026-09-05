#include <stdint.h>

/*
 * The RunAnywhere core library (librac_commons.a) is force-loaded and carries a
 * static registrar for its llama.cpp backend that references
 * rac_backend_llamacpp_register(). Minimus runs language models through
 * llama.rn instead and no longer links that backend, so the symbol would be
 * unresolved. This stub satisfies the linker and tells the registry the
 * backend is not available; the SDK is only used for the sherpa-onnx voice
 * pipeline here.
 *
 * RAC_ERROR_NOT_SUPPORTED per rac_error.h; any non-zero value means "skip".
 */
int32_t rac_backend_llamacpp_register(void) {
  return -236; /* RAC_ERROR_NOT_SUPPORTED */
}
