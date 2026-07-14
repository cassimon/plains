"""Perovskite composition coefficients must be readable by the upstream parser.

perovskite_solar_cell_database's `Perovskite.normalize()` runs a bare `float(c)`
over every ';'-separated token of composition_*_ions_coefficients. Anything it
cannot parse raises and the *whole* Perovskite section fails to normalize:

    ValueError: could not convert string to float: 'x'

'x' is the schema's own documented placeholder for an unknown coefficient, and
' | ' is its own layer separator — but the code honours neither. So we may only
emit fully numeric coefficients, and must emit no Perovskite section at all when
there is no absorber layer.
"""

import uuid
from types import SimpleNamespace

from app.services.nomad import create_nomad_metadata_yaml


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value


class _FakeSession:
    def __init__(self, values):
        self._values = iter(values)

    def exec(self, _statement):
        return _FakeResult(next(self._values))


def _layer(**overrides):
    layer = {
        "id": "step-absorber",
        "name": "Perovskite",
        "isSubstrate": False,
        "layerType": "absorber",
        "thicknessNm": "500",
        "bandgapEv": "1.58",
        "perovskiteA": "",
        "perovskiteB": "",
        "perovskiteX": "",
    }
    layer.update(overrides)
    return layer


def _sample_archive(layers):
    """Run the generator over a one-substrate experiment with the given stack."""
    experiment_id = str(uuid.uuid4())
    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=uuid.uuid4(),
        name="E",
        description="",
        architecture="n-i-p",
        frontend_data=None,
    )
    process_snapshot = {
        "id": "process-1",
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-absorber",
                        "name": "Deposition",
                        "stepCategory": "wet_deposition",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                    }
                ],
            }
        ],
        "generatedStacks": [{"combination": 1, "layers": layers}],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/ITO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }
    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_FakeSession([experiment, [], []]),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )
    return archives["sub-1_dev1_sample.archive.yaml"]["data"]


_SUBSTRATE_LAYER = {
    "id": "substrate-layer",
    "name": "Glass/ITO",
    "isSubstrate": True,
    "layerType": "",
    "thicknessNm": "",
    "bandgapEv": "",
    "perovskiteA": "",
    "perovskiteB": "",
    "perovskiteX": "",
}


def _upstream_would_parse(perovskite: dict) -> None:
    """Replay upstream's Perovskite.normalize() coefficient handling verbatim."""
    for site in ("a", "b", "c"):
        raw = perovskite.get(f"composition_{site}_ions_coefficients")
        if raw is None:
            continue
        for token in raw.split("; "):
            float(token)  # this is the line that raised on 'x'


def test_stack_without_an_absorber_emits_no_perovskite_section():
    """The reported crash: uploading a device that has no perovskite layer."""
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(id="step-etl", name="SnO2", layerType="etl"),
        ]
    )
    # No absorber → no composition to state. The old placeholder ("Unknown"
    # ions, 'x' coefficients) fabricated one *and* crashed the normalizer.
    assert "perovskite" not in sample


def test_ions_without_coefficients_omit_the_coefficients_rather_than_sending_x():
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="Cs; FA", perovskiteB="Pb", perovskiteX="I; Br"),
        ]
    )
    perovskite = sample["perovskite"]

    # The ion names — the thing the user actually stated — are kept.
    assert perovskite["composition_a_ions"] == "Cs; FA"
    assert perovskite["composition_c_ions"] == "I; Br"
    # Their coefficients are unknown, so the quantity is absent, not 'x; x'.
    assert "composition_a_ions_coefficients" not in perovskite
    assert "composition_c_ions_coefficients" not in perovskite
    # A lone ion is unambiguous: it is the whole site.
    assert perovskite["composition_b_ions_coefficients"] == "1"
    # And the composition itself still reaches NOMAD via the formula strings.
    assert perovskite["composition_short_form"] == "CsFAPbIBr"

    _upstream_would_parse(perovskite)


def test_partially_known_coefficients_are_omitted_not_half_written():
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="Cs0.1; FA", perovskiteB="Pb", perovskiteX="I3"),
        ]
    )
    perovskite = sample["perovskite"]
    # "0.1; x" would crash on the second token, so the whole list is dropped.
    assert "composition_a_ions_coefficients" not in perovskite
    assert perovskite["composition_c_ions_coefficients"] == "3"

    _upstream_would_parse(perovskite)


def test_layered_coefficients_are_omitted_because_upstream_cannot_split_them():
    """Upstream's own example is '0.51; 2.49 | x' — which its float() rejects."""
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="Cs0.1FA0.9 | MA", perovskiteB="Pb", perovskiteX="I3"),
        ]
    )
    perovskite = sample["perovskite"]
    assert "composition_a_ions_coefficients" not in perovskite

    _upstream_would_parse(perovskite)


def test_fully_numeric_coefficients_are_still_emitted():
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(
                perovskiteA="Cs0.1FA0.9",
                perovskiteB="Sn0.2Pb0.8",
                perovskiteX="I0.75Br0.25",
            ),
        ]
    )
    perovskite = sample["perovskite"]
    assert perovskite["composition_a_ions_coefficients"] == "0.1; 0.9"
    assert perovskite["composition_b_ions_coefficients"] == "0.2; 0.8"
    # Tripled: see test_the_x_site_is_scaled_to_the_three_anions_of_abx3.
    assert perovskite["composition_c_ions_coefficients"] == "2.25; 0.75"

    _upstream_would_parse(perovskite)


def test_the_x_site_is_scaled_to_the_three_anions_of_abx3():
    """The reported "FAPbBr": the X site lost its 3.

    The GUI asks for each site's ion *fractions* and validates them to sum to 1.
    On the A and B sites that is already the coefficient — one cation per formula
    unit — but ABX3 carries *three* anions, so the X site's fractions have to be
    tripled. A lone "Br" was being sent with the coefficient 1, and the formula
    NOMAD derived the material from came out as FAPbBr: not a perovskite.
    """
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="FA", perovskiteB="Pb", perovskiteX="Br"),
        ]
    )
    perovskite = sample["perovskite"]

    assert perovskite["composition_a_ions_coefficients"] == "1"
    assert perovskite["composition_b_ions_coefficients"] == "1"
    assert perovskite["composition_c_ions_coefficients"] == "3"

    # The long form is what upstream feeds to its formula normalizer, so it is
    # what `results.material` is derived from — it must carry the coefficients.
    assert perovskite["composition_long_form"] == "FAPbBr3"
    # The short form is the ion names alone, as the database defines it.
    assert perovskite["composition_short_form"] == "FAPbBr"

    _upstream_would_parse(perovskite)


def test_an_x_site_that_already_states_its_coefficients_is_left_alone():
    """ "I3" sums to 3 already — tripling it would give I9."""
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="MA", perovskiteB="Pb", perovskiteX="I3"),
        ]
    )
    perovskite = sample["perovskite"]

    assert perovskite["composition_c_ions_coefficients"] == "3"
    assert perovskite["composition_long_form"] == "MAPbI3"

    _upstream_would_parse(perovskite)


def test_the_long_form_falls_back_to_names_when_a_coefficient_is_unknown():
    """An unknown coefficient is stated as no coefficient, never as 'x'.

    'x' in a formula would be read as an element by the formula normalizer.
    """
    sample = _sample_archive(
        [
            _SUBSTRATE_LAYER,
            _layer(perovskiteA="Cs; FA", perovskiteB="Pb", perovskiteX="I; Br"),
        ]
    )
    perovskite = sample["perovskite"]

    assert perovskite["composition_long_form"] == "CsFAPbIBr"
    assert "x" not in perovskite["composition_long_form"]

    _upstream_would_parse(perovskite)
