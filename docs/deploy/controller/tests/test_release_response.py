import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "psm_controller", Path(__file__).resolve().parents[1] / "scripts" / "psm_controller.py"
)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ReleaseResponseTests(unittest.TestCase):
    def setUp(self):
        self.contract = {"target": {"fingerprint": "sha256:" + "a" * 64}}
        self.response = {
            "outcome": "succeeded", "code": "ok",
            "detail": "operation completed and was observed",
            "observedAt": "2026-09-29T07:08:54Z",
            "data": {
                "state": "activated",
                "staged": {"targetDigest": self.contract["target"]["fingerprint"]},
                "activated": {"activatedAt": "2026-09-29T07:08:53Z"},
                "verification": [{"id": "home", "state": "passed", "code": "ok"}],
            },
        }

    def test_success_uses_outcome_and_code_from_the_real_helper_protocol(self):
        state, checks, at, _ = controller.release_response(self.response, self.contract)
        self.assertEqual(state, "activated")
        self.assertEqual(checks, [{"id": "home", "state": "passed", "code": "ok"}])
        self.assertEqual(at, "2026-09-29T07:08:53Z")

    def test_failed_helper_result_is_not_treated_as_activation(self):
        response = {**self.response, "outcome": "failed", "detail": "probe failed"}
        self.assertEqual(controller.release_response(response, self.contract),
                         ("failed", [], None, "probe failed"))

    def test_success_on_another_target_is_rejected(self):
        response = {**self.response, "data": {**self.response["data"], "staged": {"targetDigest": "sha256:" + "b" * 64}}}
        with self.assertRaisesRegex(controller.ContractError, "different contract"):
            controller.release_response(response, self.contract)


if __name__ == "__main__":
    unittest.main()
