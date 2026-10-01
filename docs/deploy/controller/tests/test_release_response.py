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



class ServiceReleaseTests(unittest.TestCase):
    def test_the_artifact_algorithm_chooses_the_helper_operation(self):
        self.assertEqual(controller.HELPER_OPERATIONS["psm-static-tree-sha256@1"], "deploy-static-release")
        self.assertEqual(controller.HELPER_OPERATIONS["psm-service-tree-sha256@1"], "deploy-service-release")
        self.assertNotIn("psm-unknown@1", controller.HELPER_OPERATIONS)

    def test_a_rolled_back_service_release_reports_its_failed_health_check(self):
        contract = {"target": {"fingerprint": "sha256:" + "a" * 64}}
        response = {
            "outcome": "succeeded", "code": "ok", "detail": "operation completed and was observed",
            "observedAt": "2026-10-01T15:00:00Z",
            "data": {
                "state": "rolled-back",
                "staged": {"targetDigest": contract["target"]["fingerprint"]},
                "verification": [{"id": "health", "state": "failed", "code": "unhealthy", "detail": "HTTP 500"}],
            },
        }
        state, checks, _, _ = controller.release_response(response, contract)
        self.assertEqual(state, "rolled-back")
        self.assertEqual(checks[0]["code"], "unhealthy")

if __name__ == "__main__":
    unittest.main()
