import QuickIssueForm from "./components/QuickIssueForm";
import View from "./components/View";
import useMe from "./hooks/useMe";
import usePriorities from "./hooks/usePriorities";

function Form() {
  const { priorities, isLoadingPriorities } = usePriorities();
  const { me, isLoadingMe } = useMe();

  return <QuickIssueForm isLoading={isLoadingPriorities || isLoadingMe} priorities={priorities} me={me} />;
}

export default function Command() {
  return (
    <View>
      <Form />
    </View>
  );
}
